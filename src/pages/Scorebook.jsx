import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { ArrowLeftRight, Moon, Pencil, RotateCcw, RotateCw, Sun, X } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { fetchTeamLineup, swapLineupSlot, upsertTeamLineup, TOURNAMENT_TEAM_LINEUPS, SEASON_TEAM_LINEUPS } from '../utils/teamLineups'
import { useGameSession } from '../context/GameSessionContext'
import { useToast } from '../context/ToastContext'
import { useTournament } from '../context/TournamentContext'
import { useAuth } from '../context/AuthContext'
import { battedBallResults, calculateOutsForPa, filterRunEventsForCharacter, inningsPitchedFromOuts, isOfficialAtBat, normalizeRbiForPaResult, summarizeBatting, summarizePitching } from '../utils/statsCalculator'
import { estimateExitVelocity, exitVelocityDistanceFt, ROBBED_HR_WALL_MARGIN_FT, ROBBED_HR_CARRY_FT } from '../utils/hitDistanceStats'
import CharacterPortrait from '../components/CharacterPortrait'
import MiddleClickLink from '../components/MiddleClickLink'
import StatIcon from '../components/StatIcon'
import TeamLogo from '../components/TeamLogo'
import FieldPlayBuilder, { STADIUM_CONFIGS, estimateHitDistance, estimateHitAngle, estimateWallDistanceAtAngle, getFielderFieldSpot } from '../components/FieldPlayBuilder'
import BaserunnerField from '../components/BaserunnerField'
import { DraggableRosterItem, FieldingView, FIELD_ID_TO_SCOREBOOK_POSITION, FIELD_POSITIONS, SCOREBOOK_POSITION_TO_FIELD_ID } from '../components/RosterLineupWidgets'
import { buildChemistryHighlightSet, charactersHaveGoodChemistry } from '../utils/chemistryHighlights'
import { formatCharacterDisplayName, getCharacterChemistryName } from '../utils/mii'
import useTournamentTeamIdentity from '../hooks/useTournamentTeamIdentity'
import usePitchCount from '../hooks/usePitchCount'
import { assembleErrorNotation, assembleNotation, parseFielderChainFromNotation } from '../utils/notation'
import { buildBettingEntityLabel, estimateLiveWinProbability, generateGameOdds, mergeOddsWithExistingRows, recalculateOdds } from '../utils/oddsEngine'
import { buildOddsGenerationContext as buildSharedOddsGenerationContext } from '../utils/oddsContext'
import { persistOddsRowsWithFallback } from '../utils/oddsPersistence'
import { formatPlateAppearanceResult } from '../utils/plateAppearance'
import { resolveFirstInningNoRun, reopenGameBets, resolveGameBets, resolveOnPA } from '../utils/betResolution'
import { derivePitchingDecisions, groupRunsByPaId } from '../utils/pitchingDecisions'
import { advanceBracketOnGameComplete, reopenBracketAfterGameEdit } from '../utils/bracketProgression'
import { buildScorebookPath } from '../utils/scorebookRouting'
import { getTeamAbbreviation, getTeamPrimaryColor, getTeamShortName } from '../utils/teamIdentity'
import { DEFAULT_REGULATION_INNINGS, deriveOffense, getFinalStatusLabel, normalizeRegulationInnings } from '../utils/gameRules'
import { getHandedness } from '../utils/characterHandedness'
import {
  buildStadiumKeyByGameId,
  getOrderedStadiums,
  getStadiumSpriteStyle,
  getStadiumTimeLabel,
  normalizeIsNightForStadium,
  stadiumTimeToggleDisabled,
} from '../utils/stadiums'
import { enrichPlateAppearancesWithDerivedHitTracking } from '../utils/hitFieldDerivation'
import { useConfirmedAction, useUnsavedChangesGuard } from '../hooks/useUnsavedChangesGuard'
import { useRegisterUnsavedChanges } from '../context/UnsavedChangesContext'
import SaveLineupBar from '../components/SaveLineupBar'
import UnsavedChangesPrompt from '../components/UnsavedChangesPrompt'
import AtBatDataEntryPanel from '../components/AtBatDataEntryPanel'

function normalizeBatterHandedness(handedness) {
  return handedness === 'L' ? 'L' : 'R'
}

function directionForFielderPosition(position, batterHandedness = 'R') {
  if (position == null) return null
  const handedness = normalizeBatterHandedness(batterHandedness)
  if (['5', '6', '7'].includes(String(position))) return handedness === 'L' ? 'Oppo' : 'Pull'
  if (['1', '2', '8'].includes(String(position))) return 'Center'
  if (['3', '4', '9'].includes(String(position))) return handedness === 'L' ? 'Pull' : 'Oppo'
  return null
}

function directionForSprayAngle(angleDeg, batterHandedness = 'R') {
  const angle = Number(angleDeg)
  if (!Number.isFinite(angle)) return null
  const handedness = normalizeBatterHandedness(batterHandedness)
  if (angle <= -15) return handedness === 'L' ? 'Oppo' : 'Pull'
  if (angle >= 15) return handedness === 'L' ? 'Pull' : 'Oppo'
  return 'Center'
}

function resolveBattedBallDirection(position, angleDeg, batterHandedness = 'R') {
  const fromPosition = directionForFielderPosition(position, batterHandedness)
  if (fromPosition) return fromPosition
  return directionForSprayAngle(angleDeg, batterHandedness)
}

function batterHandednessForName(characterName) {
  return normalizeBatterHandedness(getHandedness(characterName).bats)
}

function batterHandednessForPa(pa, charactersById = {}) {
  return batterHandednessForName(charactersById[pa.character_id]?.name)
}

function batterHandednessForLineupEntry(entry, charactersById = {}) {
  return batterHandednessForName(charactersById[entry?.character_id]?.name)
}

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

function StadiumHeaderPill({ stadium, isNight, onEdit }) {
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
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          title="Edit stadium for this game"
          style={{ display: 'inline-flex', alignItems: 'center', background: 'none', border: 'none', color: C.muted, cursor: 'pointer', padding: 2 }}
        >
          <Pencil size={12} />
        </button>
      )}
    </div>
  )
}

const HIT_RESULTS  = new Set(['1B', '2B', '3B', 'HR', 'IPHR'])
const WALK_RESULTS = new Set(['BB', 'HBP'])
const CONTACT_RESULTS = new Set(['foul', 'in_play'])
// Results that need runner-resolution panel (only when runners are on base)
const NEEDS_RESOLUTION = new Set(['1B', '2B', '3B'])
const IN_PLAY_OUT_OPTIONS = ['GO', 'FO', 'LO', 'SF', 'SH']
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
const BUDDY_JUMP_RESULTS = new Set(['FO', 'LO', 'SF'])
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
  B: 'Fly Ball',
}

const OUTCOME_BUTTONS = [
  { result: '1B', zone: 'green' }, { result: '2B', zone: 'green' },
  { result: '3B', zone: 'green' }, { result: 'HR',  zone: 'green' }, { result: 'IPHR', zone: 'green' },
  { result: 'K',  zone: 'red'   }, { result: 'GO',  zone: 'red'   },
  { result: 'FO', zone: 'red'   }, { result: 'LO',  zone: 'red'   },
  { result: 'BB', zone: 'blue'  }, { result: 'HBP', zone: 'blue'  },
  { result: 'SF',  zone: 'blue'  }, { result: 'SH',  zone: 'blue'  },
]
const ZONE_COLOR = { green: C.green, red: C.red, blue: C.blue }

function normalizePa(pa) {
  if (!pa || pa.trajectory !== 'B') return pa
  return { ...pa, trajectory: 'F' }
}

function stripDbManagedFields(row = {}) {
  const next = { ...row }
  delete next.id
  delete next.created_at
  // Added only by enrichPlateAppearancesWithDerivedHitTracking for display and
  // analytics. It is not a column in either plate-appearance source table.
  delete next.hit_tracking_source
  return next
}

function didRunEventsScoreBatter(runEvents = [], batter = null) {
  if (!batter) return false
  return runEvents.some((run) => (
    String(run.playerId) === String(batter.player_id)
    && String(run.characterId) === String(batter.character_id)
  ))
}

function normalizeSavedPaRunScored(result, runScored, runEvents = [], batter = null) {
  return Boolean(runScored) || result === 'HR' || result === 'IPHR' || didRunEventsScoreBatter(runEvents, batter)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function normalizeStageLabel(stage = '') {
  if (stage.includes('CG-2')) return 'Championship Reset'
  if (stage.includes('CG-1')) return 'Championship'
  return stage
}

function getPaScoringRuns(pa = {}, runsByPaId = {}) {
  const trackedRuns = runsByPaId[String(pa.id)] || []
  if (trackedRuns.length) return trackedRuns.length
  // On a home run the batter's own run is already included in rbi (e.g. a solo HR is 1 rbi,
  // a grand slam is 4), so adding run_scored on top would double-count the batter.
  const isHomer = pa.result === 'HR' || pa.result === 'IPHR'
  return Number(pa.rbi || 0) + (pa.run_scored && !isHomer ? 1 : 0)
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

// Same "no leading zero" convention as AVG — used for OBP/SLG, which
// summarizeBatting already zeroes out when their own denominator is empty.
function formatRate(value) {
  const num = Number(value || 0)
  const formatted = num.toFixed(3)
  return num < 1 ? formatted.replace(/^0/, '') : formatted
}

// Every pitch of a PA is bulk-inserted in a single statement when the PA completes,
// so their created_at timestamps commonly land identical (or otherwise unreliable
// for tie-breaking) — sorting pitches by created_at alone can silently reorder pitches
// within the same PA, which undo relies on to find the *actual* last pitch thrown.
// pitch_number_game is a real per-pitch sequence number assigned at record time, so
// it's the only trustworthy order for pitch rows; fall back to created_at only for
// legacy rows that somehow lack it.
function comparePitchOrder(a, b) {
  const diff = Number(a.pitch_number_game || 0) - Number(b.pitch_number_game || 0)
  if (diff !== 0) return diff
  return new Date(a.created_at) - new Date(b.created_at)
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
  if (trajectory === 'F' || trajectory === 'B') {
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
    stint.pitches_thrown,
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

// Pitchers with no recorded stats are normally hidden, EXCEPT the pitcher
// currently assigned to the mound in the lineup (expectedCharacterId) — they
// should still be listed even at 0 IP, and drop off once someone else takes
// the mound. Tracks lineup edits live since expectedCharacterId comes from
// lineupDrafts.
function buildDisplayedPitchingStints(stints, playerId, expectedCharacterId) {
  const deduped = dedupePitchingStints(stints)
  const meaningful = deduped.filter(isMeaningfulPitchingStint)
  if (expectedCharacterId && !meaningful.some((stint) => Number(stint.character_id) === expectedCharacterId)) {
    const existingStint = deduped.find((stint) => Number(stint.character_id) === expectedCharacterId)
    meaningful.push(existingStint || {
      player_id: playerId,
      character_id: expectedCharacterId,
      innings_pitched: 0, hits_allowed: 0, runs_allowed: 0, earned_runs: 0, walks: 0, strikeouts: 0, hr_allowed: 0, pitches_thrown: 0, strikes_thrown: 0,
    })
  }
  return meaningful
}

// Fallback used until the game-history-calibrated odds_engine_weights row has
// loaded (or if it has none yet) — equal thirds, same as a freshly-seeded row.
const DEFAULT_ODDS_WEIGHTS = { char_stats_weight: 0.333, historical_weight: 0.333, live_weight: 0.334 }

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
  if (result === 'ROE' || result === 'FC') return 0
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

// The runner-placement screen only records *that* a runner was thrown out
// advancing during a hit (e.g. caught at the plate trying to score on a
// double) — not which fielder covered the base. That's safely implied: the
// base they were headed to when marked out has one conventional covering
// fielder, who becomes the real putout, with whoever touched the ball
// (fielderChain) credited an assist instead — same as a real "7-2" (or,
// with a cutoff man also tapped, "7-8-2") notation. Second base is the one
// genuinely ambiguous case (2B or SS can both cover); SS is the more common
// default.
const BASE_COVERING_POSITION = { first: 3, second: 6, third: 5, home: 2 }

function pendingLeavesRunnersOnBase(pending) {
  return hasAnyActiveRunners(extractNextRunners(pending))
}

function hasAnyActiveRunners(runners = {}) {
  return Boolean(runners.first || runners.second || runners.third)
}

function normalizeLiveRunner(runner = null) {
  if (!runner || runner.characterId == null || runner.playerId == null) return null
  // Preserve reachedOnError/chargedToPitcher* alongside the id fields — these
  // decide earned-run status and pitcher-of-record when this runner eventually
  // scores. Dropping them here (as this used to) meant a runner who reached on
  // an error looked "clean" again the moment live_state was read back on a
  // fresh session, silently turning a should-be-unearned run earned.
  return {
    characterId: Number(runner.characterId),
    playerId: runner.playerId,
    ...(runner.reachedOnError ? { reachedOnError: true } : {}),
    ...(runner.chargedToPitcherId != null ? { chargedToPitcherId: runner.chargedToPitcherId } : {}),
    ...(runner.chargedToPitcherPlayerId != null ? { chargedToPitcherPlayerId: runner.chargedToPitcherPlayerId } : {}),
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
    'pitcherStintId',
    'pitcher_stint_id',
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
    pitcherStintId: liveState.pitcherStintId ?? liveState.pitcher_stint_id ?? null,
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
  return hasAnyActiveRunners(runners) && ['GO', 'FO', 'LO', 'SF', 'SH', 'DP'].includes(result)
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
    // A throw to third or home retires whoever's standing on the base behind
    // it — that's true whether they were forced (bases loaded) or just
    // advancing on their own read (e.g. a runner on 2nd only, thrown out at
    // third on a 6-5). Only the batter's own advancement is force-gated,
    // since the batter is always obligated to run.
    if (touchedBase === 'home' && thirdStillOccupied) {
      outIds.push('third')
      thirdStillOccupied = false
      continue
    }
    if (touchedBase === 'third' && secondStillOccupied) {
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

  // A runner on first is forced to vacate the base the instant the ball is
  // hit on the ground, regardless of whether the batter-runner ends up safe
  // or out at first — so advancement here must not be gated on batterSafe
  // (that previously left a forced runner stranded at first on an ordinary
  // 6-3/5-3 groundout instead of advancing them to second).
  const firstAdvances = Boolean(first && !outIdSet.has('first'))
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
      // A fielder touch after the catch (e.g. the outfielder who caught a
      // leaping liner throwing back to second) means a runner left before
      // the tag-up completed and was thrown out — the throw goes back to
      // the base the runner started on, or to the plate for a runner
      // trying to score from third. Default to that runner being out
      // rather than assuming everyone safely stayed put.
      const isTaggedOut = baseKey === 'third'
        ? touchedBases.includes('third') || touchedBases.includes('home')
        : touchedBases.includes(baseKey)
      return isTaggedOut ? 'out' : baseKey
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

// ─── Merged build-the-play / runner-placement plan ────────────────────────────
// The runner placement panel shows one row per active runner (+ the batter),
// with a current `position` ('first'|'second'|'third'|'home'|'out') defaulted
// from the same prediction logic as before (computePendingState /
// computePendingOutState) and then optionally overridden by manual picks.
const BASE_STEP_ORDER = ['first', 'second', 'third', 'home']

// A runner can't be nudged back past where they actually started this play —
// for the batter that floor is first base (their best-case outcome), for a
// runner already on base it's the base they started the play on.
function runnerFloorBase(id, origin) {
  return id === 'batter' ? 'first' : origin
}

function stepBaseValue(position, direction, floor) {
  const idx = BASE_STEP_ORDER.indexOf(position)
  if (idx === -1) return position
  const floorIdx = BASE_STEP_ORDER.indexOf(floor)
  const rawNext = direction === 'advance' ? idx + 1 : idx - 1
  const clampedIdx = Math.max(floorIdx, Math.min(BASE_STEP_ORDER.length - 1, rawNext))
  return BASE_STEP_ORDER[clampedIdx]
}

// Same chain as computePendingOutState's forcedAtStart, plus the batter (who
// is always "forced" to run to first) — used so moving one forced runner to a
// new destination carries the rest of an intact force chain along with it.
function computeForcedChainIds(runners = {}) {
  const { first, second, third } = runners
  const ids = ['batter']
  if (first) ids.push('first')
  if (first && second) ids.push('second')
  if (first && second && third) ids.push('third')
  return ids
}

// Where a runner should land if they're pulled out of the "out" column but
// were never manually placed there (i.e. computePendingOutState auto-detected
// the out) — the base they'd have reached had that play not gotten them.
function computeFallbackSafePosition(id, origin, runnersAtStart) {
  if (id === 'batter') return 'first'
  const forcedIds = new Set(computeForcedChainIds(runnersAtStart))
  return forcedIds.has(id) ? getNextBase(origin) : origin
}

function computeBaselineRunnerAssignments(inPlayState, runners, batterRunner) {
  if (!inPlayState || isHomeRunResult(inPlayState.result)) return null
  const fielderChain = inPlayState.fielderChain || []
  const primaryPosition = inPlayState.isBuddyJump
    ? (fielderChain[1] || fielderChain[0] || null)
    : (fielderChain[0] || null)
  if (inPlayState.resultType === 'hit' && NEEDS_RESOLUTION.has(inPlayState.result)) {
    return computePendingState(inPlayState.result, runners, batterRunner)
  }
  if (inPlayState.resultType === 'error') {
    return computePendingState('ROE', runners, batterRunner)
  }
  if (IN_PLAY_OUT_OPTIONS.includes(inPlayState.result)) {
    return computePendingOutState(inPlayState.result, runners, batterRunner, { primaryPosition, fielderChain })
  }
  return null
}

function buildRunnerEntriesFromAssignments(pending, runnersAtStart) {
  if (!pending?.assignments) return []
  return pending.assignments.map((assignment) => ({
    id: assignment.id,
    runner: assignment.runner,
    origin: assignment.origin,
    position: assignment.destination,
    outSource: assignment.destination === 'out' ? 'auto' : null,
    preOutPosition: null,
    manual: false,
    fallbackSafePosition: computeFallbackSafePosition(assignment.id, assignment.origin, runnersAtStart),
  }))
}

// Advancing/retreating a runner who'd otherwise land on a base another
// runner already occupies pushes that occupant one base the same direction
// too (recursively, in case that cascades into a third runner) — two runners
// can never end up sharing a base, matching how a force play actually works.
// Home plate is the one exception: runners stack there, so pushing stops.
function applyManualRunnerStep(entries, id, direction) {
  const byId = Object.fromEntries(entries.map((entry) => [entry.id, entry]))
  const updates = {}
  const visiting = new Set()

  const push = (currentId) => {
    if (visiting.has(currentId)) return
    visiting.add(currentId)
    const entry = byId[currentId]
    if (!entry || entry.position === 'out') return
    const floor = runnerFloorBase(currentId, entry.origin)
    const fromPos = updates[currentId] ?? entry.position
    const nextPos = stepBaseValue(fromPos, direction, floor)
    updates[currentId] = nextPos
    if (nextPos === fromPos || nextPos === 'home') return
    const occupant = entries.find((other) => (
      other.id !== currentId && other.position !== 'out' && (updates[other.id] ?? other.position) === nextPos
    ))
    if (occupant) push(occupant.id)
  }

  push(id)

  return entries.map((entry) => (
    Object.prototype.hasOwnProperty.call(updates, entry.id)
      ? { ...entry, position: updates[entry.id], manual: true }
      : entry
  ))
}

function applyManualRunnerOut(entries, id) {
  return entries.map((entry) => (
    entry.id === id
      ? { ...entry, preOutPosition: entry.position, position: 'out', outSource: 'manual', manual: true }
      : entry
  ))
}

function applyManualRunnerReenter(entries, id) {
  return entries.map((entry) => {
    if (entry.id !== id) return entry
    const target = entry.outSource === 'manual'
      ? (entry.preOutPosition || runnerFloorBase(entry.id, entry.origin))
      : (entry.fallbackSafePosition || runnerFloorBase(entry.id, entry.origin))
    return { ...entry, position: target, outSource: null, preOutPosition: null, manual: true }
  })
}

function applyManualRunnerDestination(entries, id, destination) {
  if (destination === 'out') return applyManualRunnerOut(entries, id)

  const targetIndex = BASE_STEP_ORDER.indexOf(destination)
  if (targetIndex === -1) return entries

  let nextEntries = entries
  const findEntry = () => nextEntries.find((entry) => entry.id === id)

  if (findEntry()?.position === 'out') {
    nextEntries = applyManualRunnerReenter(nextEntries, id)
  }

  let currentEntry = findEntry()
  if (!currentEntry) return nextEntries

  let currentIndex = BASE_STEP_ORDER.indexOf(currentEntry.position)
  if (currentIndex === -1 || currentIndex === targetIndex) return nextEntries

  const direction = targetIndex > currentIndex ? 'advance' : 'retreat'
  let safety = BASE_STEP_ORDER.length + 1

  while (currentEntry.position !== destination && safety > 0) {
    nextEntries = applyManualRunnerStep(nextEntries, id, direction)
    currentEntry = findEntry()
    if (!currentEntry) break
    const nextIndex = BASE_STEP_ORDER.indexOf(currentEntry.position)
    if (nextIndex === currentIndex) break
    currentIndex = nextIndex
    safety -= 1
  }

  return nextEntries
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
  // Batter reached safely on a batted-ball out-resolution play — a fielder's choice,
  // whether or not the defense's attempt to retire someone else actually succeeded
  // (e.g. a bunt fielded and thrown home that doesn't get the lead runner in time
  // still isn't a sacrifice — the defense had the batter beaten at first and chose
  // not to take it, which is FC by rule regardless of the throw's outcome).
  if (batterSafe) return 'FC'
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
  const isHomer = pa?.result === 'HR' || pa?.result === 'IPHR'
  return Number(pa?.rbi || 0) + (pa?.run_scored && !isHomer ? 1 : 0)
}

function isHomeRunResult(result) {
  return result === 'HR' || result === 'IPHR'
}

function requiresInPlayFielderChain(result) {
  return result !== 'HR'
}

// Positions actually charged with an error for notation/scoring purposes.
// Uses whatever the scorekeeper explicitly marked with the ERROR toggle; a
// ROE result with nothing explicitly marked (the scorekeeper never touched
// the toggle) still defaults to the first fielder in the chain, since ROE is
// an error by definition and shouldn't require an extra tap to record one.
function effectiveErrorPositions(state) {
  if (state?.errorFielderPositions?.length) return state.errorFielderPositions
  if (state?.resultType === 'error' && state?.fielderChain?.[0]) return [state.fielderChain[0]]
  return []
}

function canFinalizeInPlaySelection(state, fieldersByPosition = {}) {
  if (!state?.result) return false
  if (state.result === 'HR') return true
  if (state.isBuddyJump) {
    const chain = state.fielderChain || []
    if (chain.length < 2) return false
    const nameA = fieldersByPosition[chain[0]]?.character
    const nameB = fieldersByPosition[chain[1]]?.character
    return charactersHaveGoodChemistry(nameA, nameB)
  }
  if (!requiresInPlayFielderChain(state.result)) return true
  return Boolean(state?.fielderChain?.length)
}

function isOutcomeDisabledForOuts(result, outsInHalf = 0) {
  return outsInHalf >= 2 && TWO_OUT_DISABLED_RESULTS.has(result)
}

function isOutcomeDisabledForRunners(result, runners = {}) {
  return (result === 'SF' || result === 'SH' || result === 'DP') && !hasAnyActiveRunners(runners)
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
function SectionCard({ title, subtitle = '', right = null, children, hideHeader = false }) {
  return (
    <section style={{ background: 'linear-gradient(180deg, rgba(30,41,59,0.98), rgba(15,23,42,0.98))', border: `1px solid ${C.border}`, borderRadius: 18, padding: 16, boxShadow: '0 14px 28px rgba(2,6,23,0.22)' }}>
      {!hideHeader && (title || subtitle || right) ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', marginBottom: 12 }}>
          <div>
            {title ? <div style={{ color: '#F8FAFC', fontSize: 15, fontWeight: 800 }}>{title}</div> : null}
            {subtitle ? <div style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>{subtitle}</div> : null}
          </div>
          {right}
        </div>
      ) : null}
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

function MiniRunnerDiamond({ runners, charactersById, size = 72 }) {
  const runnerSize = Math.round(size * 0.3)
  const baseSize = Math.round(size * 0.14)
  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} viewBox="0 0 72 72">
        <polygon points="36,6 62,32 36,62 10,32" fill="rgba(148,163,184,0.04)" stroke={C.border} strokeWidth="1.5" />
      </svg>
      {/* 2B — top */}
      <div style={{ position: 'absolute', left: '50%', top: 0, transform: 'translate(-50%,0)' }}>
        {runners.second
          ? <div style={{ width: runnerSize, height: runnerSize, borderRadius: '50%', overflow: 'hidden', border: `1.5px solid ${C.accent}` }}><Avatar name={charactersById[runners.second.characterId]?.name} size={runnerSize} /></div>
          : <div style={{ width: baseSize, height: baseSize, background: C.border, transform: 'rotate(45deg)', borderRadius: 1 }} />}
      </div>
      {/* 1B — right */}
      <div style={{ position: 'absolute', right: 0, top: '50%', transform: 'translate(0,-50%)' }}>
        {runners.first
          ? <div style={{ width: runnerSize, height: runnerSize, borderRadius: '50%', overflow: 'hidden', border: `1.5px solid ${C.accent}` }}><Avatar name={charactersById[runners.first.characterId]?.name} size={runnerSize} /></div>
          : <div style={{ width: baseSize, height: baseSize, background: C.border, transform: 'rotate(45deg)', borderRadius: 1 }} />}
      </div>
      {/* 3B — left */}
      <div style={{ position: 'absolute', left: 0, top: '50%', transform: 'translate(0,-50%)' }}>
        {runners.third
          ? <div style={{ width: runnerSize, height: runnerSize, borderRadius: '50%', overflow: 'hidden', border: `1.5px solid ${C.accent}` }}><Avatar name={charactersById[runners.third.characterId]?.name} size={runnerSize} /></div>
          : <div style={{ width: baseSize, height: baseSize, background: C.border, transform: 'rotate(45deg)', borderRadius: 1 }} />}
      </div>
      {/* Home — bottom */}
      <div style={{ position: 'absolute', left: '50%', bottom: 0, transform: 'translate(-50%,0)' }}>
        <div style={{ width: baseSize * 0.9, height: baseSize * 0.9, background: C.card, border: `1.5px solid ${C.border}`, transform: 'rotate(45deg)', borderRadius: 1 }} />
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
  activeBattingSide = null,
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
              <th key={inning} style={{ padding: `0 ${compact ? 4 : 0}px ${compact ? 6 : 10}px`, color: inning === currentInning && activeBattingSide ? C.accent : C.muted, fontSize: headerFontSize, fontWeight: 800 }}>{inning}</th>
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
              {innings.map((inning) => {
                const isActiveHalf = inning === currentInning && team.battingSide === activeBattingSide
                return (
                  <td key={`${team.key}-${inning}`} style={{ padding: cellPad, borderTop: `1px solid ${C.border}44`, textAlign: 'center', background: isActiveHalf ? `${C.accent}20` : 'transparent', color: isActiveHalf ? '#F8FAFC' : '#CBD5E1', fontSize: cellFontSize, fontWeight: 700 }}>
                    {getLineScoreCellValue({ inning, side: team.battingSide, scoreMap: team.scoreMap, completedHalfCount })}
                  </td>
                )
              })}
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
  getCharacterLink,
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
                {['AB', 'R', 'H', 'RBI', 'HR', 'BB', 'K', 'AVG', 'OBP', 'SLG'].map((label) => (
                  <th key={label} style={{ padding: '0 0 10px', textAlign: 'center', color: C.muted, fontSize: 11, fontWeight: 800 }}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {lineup.map((entry, index) => {
                const key = `${entry.player_id}:${entry.character_id}`
                const stats = statsByEntryKey[key] || { game: summarizeBatting([]), source: summarizeBatting([]) }
                const isCurrent = key === currentEntryKey
                const link = getCharacterLink ? getCharacterLink(entry.character_id, entry.player_id) : null
                return (
                  <tr key={key}>
                    <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44` }}>
                      <MiddleClickLink
                        to={link?.to}
                        state={link?.state}
                        style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: link ? 'pointer' : 'default', color: 'inherit', textDecoration: 'none' }}
                      >
                        <span style={{ width: 18, color: isCurrent ? teamColor : C.muted, fontSize: 11, fontWeight: 800 }}>{index + 1}</span>
                        <div style={{ width: 30, height: 30, borderRadius: '50%', overflow: 'hidden', border: `1.5px solid ${isCurrent ? teamColor : C.border}` }}>
                          <Avatar name={charactersById[entry.character_id]?.name} size={30} />
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ color: isCurrent ? teamColor : '#F8FAFC', fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{charactersById[entry.character_id]?.name || 'Unknown'}</div>
                          {isCurrent ? <div style={{ color: C.muted, fontSize: 11 }}>Current batter</div> : null}
                        </div>
                      </MiddleClickLink>
                    </td>
                    <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stats.game.atBats}</td>
                    <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stats.game.runs}</td>
                    <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stats.game.hits}</td>
                    <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stats.game.rbi}</td>
                    <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stats.game.homeRuns}</td>
                    <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stats.game.walks}</td>
                    <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stats.game.strikeouts}</td>
                    <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13, fontWeight: 700 }}>{formatBaseballAverage(stats.source)}</td>
                    <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13, fontWeight: 700 }}>{formatRate(stats.source.obp)}</td>
                    <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13, fontWeight: 700 }}>{formatRate(stats.source.slg)}</td>
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

function PitchingStatsTable({ title, stints, decisionLabels, charactersById, getCharacterLink, sourceStatsByCharacterKey = {} }) {
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
                {['IP', 'H', 'R', 'ER', 'BB', 'K', 'HR', 'PC-ST', 'ERA'].map((label) => (
                  <th key={label} style={{ padding: '0 0 10px', textAlign: 'center', color: C.muted, fontSize: 11, fontWeight: 800 }}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stints.map((stint) => {
                const link = getCharacterLink ? getCharacterLink(stint.character_id, stint.player_id) : null
                const sourceStats = sourceStatsByCharacterKey[`${stint.player_id}:${stint.character_id}`]
                return (
                <tr key={stint.id}>
                  <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44` }}>
                    <MiddleClickLink
                      to={link?.to}
                      state={link?.state}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: link ? 'pointer' : 'default', color: 'inherit', textDecoration: 'none' }}
                    >
                      <div style={{ width: 30, height: 30, borderRadius: '50%', overflow: 'hidden', border: `1.5px solid ${C.border}` }}>
                        <Avatar name={charactersById[stint.character_id]?.name} size={30} />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ color: '#F8FAFC', fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{charactersById[stint.character_id]?.name || 'Unknown'}</div>
                        {decisionLabels[stint.id] ? <div style={{ color: C.accent, fontSize: 11, fontWeight: 800 }}>{decisionLabels[stint.id]}</div> : null}
                      </div>
                    </MiddleClickLink>
                  </td>
                  <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stint.innings_pitched ?? 0}</td>
                  <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stint.hits_allowed ?? 0}</td>
                  <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stint.runs_allowed ?? 0}</td>
                  <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stint.earned_runs ?? 0}</td>
                  <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stint.walks ?? 0}</td>
                  <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stint.strikeouts ?? 0}</td>
                  <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stint.hr_allowed ?? 0}</td>
                  <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13 }}>{stint.pitches_thrown ?? 0}-{stint.strikes_thrown ?? 0}</td>
                  <td style={{ padding: '10px 0', borderTop: `1px solid ${C.border}44`, textAlign: 'center', fontSize: 13, fontWeight: 700 }}>{Number(sourceStats?.era || 0).toFixed(2)}</td>
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
  const [searchParams] = useSearchParams()
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
  const [stadiumEditModalOpen, setStadiumEditModalOpen] = useState(false)
  const [stadiumEditForm, setStadiumEditForm] = useState({ stadiumId: '', isNight: false })
  const [stadiumEditSaving, setStadiumEditSaving] = useState(false)
  const [gameBets, setGameBets] = useState([])
  const [pitchHistoryLoadedScope, setPitchHistoryLoadedScope] = useState(null)
  // Calibrated char_stats_weight/historical_weight/live_weight, recomputed by
  // runPostGameCalibration after every resolved game from actual prediction
  // accuracy (see betResolution.js). Feeds the win-probability model so it
  // gets more accurate over time instead of using fixed weights forever.
  const [oddsEngineWeights, setOddsEngineWeights] = useState(null)
  const [dataLoaded, setDataLoaded] = useState(false)

  // ── UI state ───────────────────────────────────────────────────────────────
  const [selectedGameId, setSelectedGameId] = useState(gameSession?.gameId ? String(gameSession.gameId) : '')
  // A `?view=` query param (e.g. from a Team page game-log link wanting the read-only recap,
  // not the live scoring UI) overrides the scorekeeper/spectator role-based default below.
  const [viewMode, setViewMode] = useState(() => (
    searchParams.get('view') || (player && (player.is_commissioner || player.scorebook_access) ? 'scorebook' : 'game')
  ))
  const [viewedInning, setViewedInning] = useState(null)
  const [overrideBatterIdx, setOverrideBatterIdx] = useState(null)
  const [showOutsBanner, setShowOutsBanner] = useState(false)
  const [gameEndBanner, setGameEndBanner] = useState(null)
  // outsRecorded at the moment the scorekeeper last dismissed the game-end
  // banner via "Continue Playing" — the reload-recovery effect below re-derives
  // that same banner from persisted data on every render where its trigger
  // conditions still hold, which (without this) meant clearing the banner just
  // made it reappear on the very next render. Once outsRecorded moves past this
  // value (a real additional out gets recorded), the dismissal no longer
  // applies and a genuinely new end-of-game condition can show the banner again.
  const dismissedGameEndOutsRef = useRef(null)
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
  const paPitchRowsRef = useRef([])
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
  const [viewedLineupSide, setViewedLineupSide] = useState('A')
  const [viewportWidth, setViewportWidth] = useState(() => typeof window !== 'undefined' ? window.innerWidth : 1280)
  const isNarrowViewport = viewportWidth <= 720
  useEffect(() => {
    const handleResize = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])
  const isStackedInPlayLayout = viewportWidth <= 980
  const [showEndGameConfirm, setShowEndGameConfirm] = useState(false)
  const [showReopenGameConfirm, setShowReopenGameConfirm] = useState(false)
  const [runnerStateLoadedScope, setRunnerStateLoadedScope] = useState(null)
  const [activePaLoadedScope, setActivePaLoadedScope] = useState(null)
  const [redoAction, setRedoAction] = useState(null)
  const [isUndoInFlight, setIsUndoInFlight] = useState(false)
  const [queuedUndoCorrection, setQueuedUndoCorrection] = useState(null)

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
  const locallyDeletedPaIdsRef = useRef(new Set())
  const localActivePaRestoreRef = useRef(null)
  const undoInFlightRef = useRef(false)
  const queuedUndoCorrectionRef = useRef(null)
  const pitchHistoryLoadedScopeRef = useRef(null)
  const isSyncingLineupsRef = useRef(false)
  const lastSyncedLineupSignatureRef = useRef(null)
  const pitcherChangePendingRef = useRef(false)
  const [isPitchActionPending, setIsPitchActionPending] = useState(false)

  // Tournament settings
  const regulationInnings = normalizeRegulationInnings(
    gameSession?.innings ?? tournament?.innings,
    DEFAULT_REGULATION_INNINGS,
  )
  const mercyOn  = gameSession?.mercyRule ?? tournament?.mercy_rule !== false
  const mercyLimit = Math.max(1, Number(gameSession?.mercyRuleDifferential || 10))
  const scorebookDataScope = `${gameSession?.sourceType || 'unknown'}:${gameSession?.sourceId || 'none'}:${gameSession?.gameId || 'none'}`

  const pushRunners = useCallback((next) => {
    setRunnersHistory(prev => [...prev, { ...runners }])
    setRunners(next)
  }, [runners])

  const popRunners = useCallback(() => {
    if (!runnersHistory.length) return
    // Apply both updates in the same tick — deferring setRunners to a microtask
    // (the previous approach) let several unrelated re-renders land in between
    // (each undo await triggers its own setPlateAppearances/setPitches/etc.),
    // so the runner diamond would flash through stale states before the
    // restored one finally showed up a beat later.
    setRunnersHistory(runnersHistory.slice(0, -1))
    setRunners(runnersHistory[runnersHistory.length - 1])
  }, [runnersHistory])

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
    let cancelled = false
    // The session provider refreshes after live-state writes. Keep an already
    // verified snapshot editable while that same game's background refresh is
    // in flight; clearing this flag here unmounted every scoring control and
    // made the scorebook visibly flash after each entry.
    const hasUsableSnapshot = pitchHistoryLoadedScopeRef.current === scorebookDataScope
    if (!hasUsableSnapshot) {
      pitchHistoryLoadedScopeRef.current = null
      setPitchHistoryLoadedScope(null)
    }

    async function load() {
      try {
        const {
          games: gamesData = [],
          players: playersData = [],
          lineups: lineupsData = [],
          characters: charsData = [],
          draftPicks: picksData = [],
          plateAppearances: pasData = [],
          pitchingStints: pitchData = [],
          pitches: pitchRowsData,
          pitchLoadError = null,
          loadError = null,
          gameFielders: fieldersData = [],
          runsScored: runsData = [],
          inningScores: inningScoresData = [],
          stadiums: stadiumsData = [],
          stadiumGameLog: stadiumLogData = [],
        } = await gameSession.loadScorebookData()
        if (cancelled) return
        if (loadError || pitchLoadError || !Array.isArray(pitchRowsData)) {
          throw loadError || pitchLoadError || new Error('The selected game pitch history could not be loaded.')
        }

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
        const visiblePAs = (pasData || [])
          .map(normalizePa)
          .filter((pa) => !locallyDeletedPaIdsRef.current.has(String(pa.id)))
        const visiblePitches = (pitchRowsData || [])
          .filter((pitch) => !locallyDeletedPaIdsRef.current.has(String(pitch.pa_id)))
        const visibleRuns = (runsData || [])
          .filter((run) => !locallyDeletedPaIdsRef.current.has(String(run.pa_id)))
        setDraftPicks(picksData || [])
        setPlateAppearances(prev => preserveSelectedGameRows(prev, visiblePAs))
        setPitchingStints(prev => preserveSelectedGameRows(prev, (pitchData && pitchData.length) ? pitchData : (prev.length ? prev : pitchData)))
        setPitches(prev => preserveSelectedGameRows(prev, visiblePitches))
        setGameFielders(prev => preserveSelectedGameRows(prev, (fieldersData && fieldersData.length) ? fieldersData : (prev.length ? prev : fieldersData)))
        setRunsScored(prev => preserveSelectedGameRows(prev, visibleRuns))
        setInningScores(inningScoresData || [])
        setStadiums(getOrderedStadiums(stadiumsData || []))
        setStadiumGameLog(stadiumLogData || [])
        pitchHistoryLoadedScopeRef.current = scorebookDataScope
        setPitchHistoryLoadedScope(scorebookDataScope)
        setDataLoaded(true)
      } catch (error) {
        if (cancelled) return
        if (hasUsableSnapshot) {
          console.warn('[scorebook load] refresh failed; preserving the verified local snapshot', error)
          return
        }
        pitchHistoryLoadedScopeRef.current = null
        setPitchHistoryLoadedScope(null)
        pushToast({
          title: 'Pitch history unavailable',
          message: `${error.message} Scorekeeping is disabled so an incomplete pitch total cannot be saved.`,
          type: 'error',
        })
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [gameSession, tournament?.id, pushToast, scorebookDataScope, selectedGameId])

  useEffect(() => {
    setSelectedGameId(gameSession?.gameId ? String(gameSession.gameId) : '')
  }, [gameSession?.gameId])

  // Load the game-history-calibrated weights and keep them live so the win
  // probability model improves mid-session as other games get resolved.
  useEffect(() => {
    let active = true
    supabase.from('odds_engine_weights').select('*').eq('id', 1).maybeSingle().then(({ data }) => {
      if (active && data) setOddsEngineWeights(data)
    })
    const channel = supabase
      .channel(`scorebook-odds-weights-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'odds_engine_weights' }, async () => {
        const { data } = await supabase.from('odds_engine_weights').select('*').eq('id', 1).maybeSingle()
        if (active && data) setOddsEngineWeights(data)
      })
      .subscribe()
    return () => {
      active = false
      supabase.removeChannel(channel)
    }
  }, [])

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
        const { data, error } = await supabase.from(scorebookTables.lineups).select('*').eq('game_id', selectedGameId).order('batting_order')
        if (error) {
          console.warn('[scorebook realtime] lineup refresh failed; preserving local rows', error)
          return
        }
        const nextRows = data || []
        setLineups((current) => {
          const currentGameRows = current.filter((row) => String(row.game_id) === String(selectedGameId))
          if (shouldDeferRealtimeMerge(currentGameRows, nextRows)) return current
          return [...current.filter((row) => String(row.game_id) !== String(selectedGameId)), ...nextRows]
        })
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: scorebookTables.plateAppearances, filter: `game_id=eq.${selectedGameId}` }, async () => {
        const { data, error } = await supabase.from(scorebookTables.plateAppearances).select('*').eq('game_id', selectedGameId).order('created_at')
        if (error) {
          console.warn('[scorebook realtime] plate-appearance refresh failed; preserving local rows', error)
          return
        }
        const nextRows = (data || [])
          .map(normalizePa)
          .filter((pa) => !locallyDeletedPaIdsRef.current.has(String(pa.id)))
        setPlateAppearances((current) => {
          const currentGameRows = current.filter((row) => String(row.game_id) === String(selectedGameId))
          if (shouldDeferRealtimeMerge(currentGameRows, nextRows)) return current
          return [...current.filter((row) => String(row.game_id) !== String(selectedGameId)), ...nextRows]
        })
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: scorebookTables.pitchingStints, filter: `game_id=eq.${selectedGameId}` }, async () => {
        const { data, error } = await supabase.from(scorebookTables.pitchingStints).select('*').eq('game_id', selectedGameId).order('created_at')
        if (error) {
          console.warn('[scorebook realtime] pitching refresh failed; preserving local rows', error)
          return
        }
        const nextRows = data || []
        setPitchingStints((current) => {
          const currentGameRows = current.filter((row) => String(row.game_id) === String(selectedGameId))
          if (shouldDeferRealtimeMerge(currentGameRows, nextRows)) return current
          return [...current.filter((row) => String(row.game_id) !== String(selectedGameId)), ...nextRows]
        })
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: scorebookTables.pitches, filter: `game_id=eq.${selectedGameId}` }, async () => {
        const { data, error } = await supabase.from(scorebookTables.pitches).select('*').eq('game_id', selectedGameId).order('created_at')
        if (error) {
          console.warn('[scorebook realtime] pitch refresh failed; preserving local rows', error)
          return
        }
        const nextRows = (data || [])
          .filter((pitch) => !locallyDeletedPaIdsRef.current.has(String(pitch.pa_id)))
        setPitches((current) => {
          const currentGameRows = current.filter((row) => String(row.game_id) === String(selectedGameId))
          if (shouldDeferRealtimeMerge(currentGameRows, nextRows)) return current
          return [...current.filter((row) => String(row.game_id) !== String(selectedGameId)), ...nextRows]
        })
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: scorebookTables.gameFielders, filter: `game_id=eq.${selectedGameId}` }, async () => {
        const { data, error } = await supabase.from(scorebookTables.gameFielders).select('*').eq('game_id', selectedGameId).order('created_at')
        if (error) {
          console.warn('[scorebook realtime] fielder refresh failed; preserving local rows', error)
          return
        }
        const nextRows = data || []
        setGameFielders((current) => {
          const currentGameRows = current.filter((row) => String(row.game_id) === String(selectedGameId))
          if (shouldDeferRealtimeMerge(currentGameRows, nextRows)) return current
          return [...current.filter((row) => String(row.game_id) !== String(selectedGameId)), ...nextRows]
        })
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: scorebookTables.runsScored, filter: `game_id=eq.${selectedGameId}` }, async () => {
        const { data, error } = await supabase.from(scorebookTables.runsScored).select('*').eq('game_id', selectedGameId).order('created_at')
        if (error) {
          console.warn('[scorebook realtime] run refresh failed; preserving local rows', error)
          return
        }
        const nextRows = (data || [])
          .filter((run) => !locallyDeletedPaIdsRef.current.has(String(run.pa_id)))
        setRunsScored((current) => {
          const currentGameRows = current.filter((row) => String(row.game_id) === String(selectedGameId))
          if (shouldDeferRealtimeMerge(currentGameRows, nextRows)) return current
          return [...current.filter((row) => String(row.game_id) !== String(selectedGameId)), ...nextRows]
        })
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: scorebookTables.inningScores, filter: `game_id=eq.${selectedGameId}` }, async () => {
        const query = supabase.from(scorebookTables.inningScores).select('*').eq('game_id', selectedGameId).order('inning')
        const { data, error } = isSeasonGame
          ? await query.eq('season_id', gameSession?.sourceId)
          : await query
        if (error) {
          console.warn('[scorebook realtime] inning-score refresh failed; preserving local rows', error)
          return
        }
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

  // Belt-and-suspenders refetch for edits made in another tab (the At-Bat
  // Data page's "Edit At-Bat" link opens in one) — the realtime subscription
  // above should already catch these, but resyncs on refocus too in case a
  // given table isn't in the realtime publication, same pattern already used
  // for team lineups above. Deliberately does NOT run through
  // shouldDeferRealtimeMerge — that guard exists to protect the few seconds
  // right after a local save from a lagging read-replica, which doesn't
  // apply here (a refocus fires well after any such window, often minutes
  // later). Applying it here actively defeats the point of a "just trust the
  // fresh fetch" resync: if local state has drifted for any reason (a stale
  // extra row, a miscount), the guard's "fewer rows than we already have ->
  // skip" rule would keep discarding the correct fetch forever.
  useEffect(() => {
    if (!selectedGameId) return
    const resync = async () => {
      const [pitchResult, paResult, stintResult] = await Promise.all([
        supabase.from(scorebookTables.pitches).select('*').eq('game_id', selectedGameId).order('created_at'),
        supabase.from(scorebookTables.plateAppearances).select('*').eq('game_id', selectedGameId).order('created_at'),
        supabase.from(scorebookTables.pitchingStints).select('*').eq('game_id', selectedGameId).order('created_at'),
      ])
      if (!pitchResult.error) {
        const visiblePitches = (pitchResult.data || [])
          .filter((pitch) => !locallyDeletedPaIdsRef.current.has(String(pitch.pa_id)))
        setPitches((current) => [...current.filter((row) => String(row.game_id) !== String(selectedGameId)), ...visiblePitches])
      } else {
        console.warn('[scorebook focus] pitch refresh failed; preserving local rows', pitchResult.error)
      }
      if (!paResult.error) {
        const visiblePAs = (paResult.data || [])
          .map(normalizePa)
          .filter((pa) => !locallyDeletedPaIdsRef.current.has(String(pa.id)))
        setPlateAppearances((current) => [...current.filter((row) => String(row.game_id) !== String(selectedGameId)), ...visiblePAs])
      } else {
        console.warn('[scorebook focus] plate-appearance refresh failed; preserving local rows', paResult.error)
      }
      if (!stintResult.error) {
        setPitchingStints((current) => [...current.filter((row) => String(row.game_id) !== String(selectedGameId)), ...(stintResult.data || [])])
      } else {
        console.warn('[scorebook focus] pitching refresh failed; preserving local rows', stintResult.error)
      }
    }
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') resync()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    window.addEventListener('focus', resync)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('focus', resync)
    }
  }, [selectedGameId, scorebookTables])

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
  const canEditScorebook = Boolean(
    isScorekeeper
    && selectedGame
    && !isGameComplete
    && dataLoaded
    && pitchHistoryLoadedScope === scorebookDataScope
  )
  const selectedGameLiveState = useMemo(
    () => normalizeLiveState(selectedGame?.live_state),
    [selectedGame?.live_state],
  )
  const playersById   = useMemo(() => Object.fromEntries(players.map(p => [p.id, p])), [players])
  const charactersById = useMemo(() => Object.fromEntries(characters.map(c => [c.id, c])), [characters])
  const charactersByName = useMemo(() => Object.fromEntries(characters.map((character) => [character.name, character])), [characters])
  // Shared by both the plain-click handler and the middle-click-friendly <a> links
  // in the Game View tab (MiddleClickLink needs a real `to`/`state` pair up front
  // rather than an onClick that fires navigate() imperatively).
  const getCharacterLinkTarget = useCallback((characterId) => {
    const character = charactersById[characterId]
    if (!character) return null
    const ownerPick = draftPicks.find((pick) => Number(pick.character_id) === Number(characterId) && pick.is_active !== false) || null
    const currentOwner = ownerPick ? { player_id: ownerPick.player_id } : null
    return {
      to: `/character/${characterId}/career`,
      state: {
        backTo: window.location.pathname + window.location.search,
        character,
        allCharactersById: Object.fromEntries(characters.map((entry) => [entry.name, entry])),
        playersById,
        identitiesByPlayerId,
        currentOwner,
        currentContext: gameSession?.sourceId ? { type: isSeasonGame ? 'season' : 'tournament', id: gameSession.sourceId } : null,
        rosterNames: [],
      },
    }
  }, [charactersById, characters, draftPicks, playersById, identitiesByPlayerId, gameSession?.sourceId, isSeasonGame])
  const openCharacterPage = useCallback((characterId) => {
    const target = getCharacterLinkTarget(characterId)
    if (!target) return
    navigate(target.to, { state: target.state })
  }, [getCharacterLinkTarget, navigate])
  const stadiumsById = useMemo(() => Object.fromEntries(stadiums.map((stadium) => [stadium.id, stadium])), [stadiums])
  const stadiumKeyByGameId = useMemo(
    () => buildStadiumKeyByGameId(games, stadiums, stadiumGameLog),
    [games, stadiums, stadiumGameLog],
  )
  const trackedPlateAppearances = useMemo(
    () => enrichPlateAppearancesWithDerivedHitTracking(plateAppearances, stadiumKeyByGameId),
    [plateAppearances, stadiumKeyByGameId],
  )
  const selectedStadium = selectedGame?.stadium_id ? stadiumsById[selectedGame.stadium_id] : null
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
  const stadiumKey = STADIUM_NAME_TO_KEY[selectedStadium?.name] ?? null
  const selectedAddGameStadium = addGameForm.stadiumId ? stadiumsById[addGameForm.stadiumId] : stadiums[0] || null

  const openStadiumEditModal = useCallback(() => {
    if (!selectedGame) return
    setStadiumEditForm({
      stadiumId: selectedStadium?.id || stadiums[0]?.id || '',
      isNight: Boolean(selectedGame.is_night),
    })
    setStadiumEditModalOpen(true)
  }, [selectedGame, selectedStadium, stadiums])

  const saveStadiumEdit = useCallback(async () => {
    if (!selectedGame) return
    const stadium = stadiumsById[stadiumEditForm.stadiumId]
    if (!stadium) return
    const nextIsNight = normalizeIsNightForStadium(stadium, stadiumEditForm.isNight)
    // The scheduled game row is the live source of truth. Historical log rows are only
    // written when a game is completed, so editing setup here should touch the game row only.
    const patch = isSeasonGame
      ? { stadium: stadium.name, is_night: nextIsNight }
      : { stadium_id: stadium.id, is_night: nextIsNight }

    setStadiumEditSaving(true)
    try {
      const { error } = await supabase.from(scorebookTables.games).update(patch).eq('id', selectedGame.id)
      if (error) throw error

      setGames((current) => current.map((game) => (
        String(game.id) === String(selectedGame.id)
          ? { ...game, ...patch, stadium_id: stadium.id }
          : game
      )))
      setStadiumEditModalOpen(false)
      pushToast({ title: 'Stadium updated', message: `${stadium.name} set for this game.`, type: 'success' })
    } catch (error) {
      pushToast({ title: 'Unable to update stadium', message: error.message, type: 'error' })
    } finally {
      setStadiumEditSaving(false)
    }
  }, [selectedGame, stadiumsById, stadiumEditForm, isSeasonGame, scorebookTables.games, pushToast])

  const [videoUrlDraft, setVideoUrlDraft] = useState('')
  const [videoUrlSaving, setVideoUrlSaving] = useState(false)

  useEffect(() => {
    setVideoUrlDraft(selectedGame?.video_url || '')
  }, [selectedGame])

  const saveVideoUrl = useCallback(async () => {
    if (!selectedGame) return
    setVideoUrlSaving(true)
    try {
      const patch = { video_url: videoUrlDraft || null }
      const { error } = await supabase.from(scorebookTables.games).update(patch).eq('id', selectedGame.id)
      if (error) throw error

      setGames((current) => current.map((game) => (
        String(game.id) === String(selectedGame.id) ? { ...game, ...patch } : game
      )))
      pushToast({ title: 'Video URL saved', type: 'success' })
    } catch (error) {
      pushToast({ title: 'Unable to save video URL', message: error.message, type: 'error' })
    } finally {
      setVideoUrlSaving(false)
    }
  }, [selectedGame, videoUrlDraft, scorebookTables.games, pushToast])

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
    () => trackedPlateAppearances.filter(p => String(p.game_id) === String(selectedGameId)).sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
    [trackedPlateAppearances, selectedGameId],
  )

  const handleSaveExitVelocity = useCallback(async (pa, patch) => {
    const { data: savedPa, error } = await supabase
      .from(scorebookTables.plateAppearances)
      .update(patch)
      .eq('id', pa.id)
      .select()
      .single()
    if (error) {
      pushToast({ title: 'Exit velocity save failed', message: error.message, type: 'error' })
      return
    }
    setPlateAppearances((cur) => cur.map((row) => (row.id === savedPa.id ? { ...row, ...savedPa } : row)))
  }, [scorebookTables.plateAppearances, pushToast])

  const handleSavePitchType = useCallback(async (pitchId, patch) => {
    const { data: savedPitch, error } = await supabase
      .from(scorebookTables.pitches)
      .update(patch)
      .eq('id', pitchId)
      .select()
      .single()
    if (error) {
      pushToast({ title: 'Pitch type save failed', message: error.message, type: 'error' })
      return
    }
    setPitches((cur) => cur.map((row) => (row.id === savedPitch.id ? { ...row, ...savedPitch } : row)))
  }, [scorebookTables.pitches, pushToast])

  const gamePitching = useMemo(
    () => pitchingStints.filter(p => String(p.game_id) === String(selectedGameId)),
    [pitchingStints, selectedGameId],
  )
  const gamePitches = useMemo(
    () => pitches.filter((pitch) => String(pitch.game_id) === String(selectedGameId)).sort(comparePitchOrder),
    [pitches, selectedGameId],
  )
  const gameFielderRows = useMemo(
    () => gameFielders
      .filter((fielder) => String(fielder.game_id) === String(selectedGameId))
      .map((fielder) => {
        const characterName = fielder.character
          || fielder.character_name
          || (fielder.character_id ? charactersById[fielder.character_id]?.name : '')
          || ''
        const characterId = fielder.character_id
          ?? (characterName ? charactersByName[characterName]?.id ?? null : null)
        return {
          ...fielder,
          ...(characterName ? { character: characterName } : {}),
          ...(characterId != null ? { character_id: characterId } : {}),
        }
      }),
    [gameFielders, selectedGameId, charactersById, charactersByName],
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

  const outsRecorded = useMemo(() => gamePAs.reduce((s, pa) => s + calculateOutsForPa(pa.result, pa.outs_on_play), 0), [gamePAs])
  useEffect(() => { outsRef.current = outsRecorded }, [outsRecorded])

  const outsInHalf = outsRecorded % 3
  const selectionOutsInHalf = useMemo(() => {
    if (!editingPa) return outsInHalf
    const editingIndex = gamePAs.findIndex((pa) => String(pa.id) === String(editingPa.id))
    if (editingIndex === -1) return outsInHalf
    const outsBeforeEditingPa = gamePAs
      .slice(0, editingIndex)
      .reduce((sum, pa) => sum + calculateOutsForPa(pa.result, pa.outs_on_play), 0)
    return outsBeforeEditingPa % 3
  }, [editingPa, gamePAs, outsInHalf])
  const offense = useMemo(() => selectedGame ? deriveOffense(selectedGame, outsRecorded) : null, [selectedGame, outsRecorded])

  // True once an error has occurred in the CURRENT half-inning that would have been the
  // inning-ending 3rd out (batter reaches on error with 2 outs already recorded) — per
  // official scoring, the inning should already be over at that point, so every run that
  // scores afterward this half, however cleanly, is unearned. Reconstructed from gamePAs
  // (not a mutable ref) so it stays correct across undo/redo/edits and resets naturally at
  // each half-inning boundary via the outs-mod-3 walk.
  const inningExtendedByError = useMemo(() => {
    let outsInHalfSoFar = 0
    let extended = false
    for (const pa of gamePAs) {
      if (pa.is_error && outsInHalfSoFar === 2) extended = true
      outsInHalfSoFar += calculateOutsForPa(pa.result, pa.outs_on_play)
      if (outsInHalfSoFar >= 3) {
        outsInHalfSoFar = 0
        extended = false
      }
    }
    return extended
  }, [gamePAs])

  // Batting/pitching team display info
  const battingPlayer  = selectedGame ? playersById[offense?.battingPlayerId]  : null
  const pitchingPlayer = selectedGame ? playersById[offense?.pitchingPlayerId] : null
  const teamAPlayer    = selectedGame ? playersById[selectedGame.team_a_player_id] : null
  const teamBPlayer    = selectedGame ? playersById[selectedGame.team_b_player_id] : null
  const teamAIdentity  = identitiesByPlayerId[selectedGame?.team_a_player_id] || null
  const teamBIdentity  = identitiesByPlayerId[selectedGame?.team_b_player_id] || null
  const teamAName      = getTeamShortName(teamAIdentity) || teamAIdentity?.teamName || teamAPlayer?.name || 'Team A'
  const teamBName      = getTeamShortName(teamBIdentity) || teamBIdentity?.teamName || teamBPlayer?.name || 'Team B'
  const battingIdentity  = identitiesByPlayerId[offense?.battingPlayerId] || null
  const pitchingIdentity = identitiesByPlayerId[offense?.pitchingPlayerId] || null
  const teamAColor     = getTeamPrimaryColor(teamAIdentity, teamAPlayer?.color) || C.blue
  const teamBColor     = getTeamPrimaryColor(teamBIdentity, teamBPlayer?.color) || C.red
  const teamAAbbreviation = getTeamAbbreviation(teamAIdentity || teamAPlayer) || teamAName.slice(0, 4).toUpperCase()
  const teamBAbbreviation = getTeamAbbreviation(teamBIdentity || teamBPlayer) || teamBName.slice(0, 4).toUpperCase()
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
  const currentBatterHandedness = batterHandednessForLineupEntry(currentBatter, charactersById)
  const onDeckBatter   = currentLineup[(effectiveBatterIdx + 1) % Math.max(currentLineup.length, 1)]

  // Current pitcher (last stint for defensive team this game)
  const currentPitcherStint = useMemo(() => {
    if (!offense) return null
    const stints = gamePitching.filter(s => s.player_id === offense.pitchingPlayerId)
    return stints[stints.length - 1] ?? null
  }, [gamePitching, offense])
  const currentPitcherChar = currentPitcherStint ? charactersById[currentPitcherStint.character_id] : null
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
  const currentPitcherStorageKey = `${scorebookDataScope}:${currentPitcherStint?.id || currentPitcherStint?.character_id || 'none'}`
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
    const restoredRows = Array.isArray(snapshot.paPitchRows) ? snapshot.paPitchRows : []
    paPitchRowsRef.current = restoredRows
    setPaPitchRows(restoredRows)
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
    pitchActionPendingRef.current = false
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

  // Cumulative stats shown in Game View (lineup AVG/OBP/SLG, pitcher ERA, etc.) should be a
  // snapshot as of the game being viewed — not live season/tournament-to-date numbers that keep
  // shifting every time a later game gets scored. `round_number` (season) reflects true schedule
  // order even when rows were bulk-imported; `created_at` can't be trusted for that (a whole bulk-
  // imported tournament/season can share one identical timestamp), but each row's own `id` is
  // still assigned in real creation order, so it's a safe fallback for tournament games.
  const gameOrderKey = useCallback((g) => (
    g?.round_number != null ? Number(g.round_number) : Number(g?.id)
  ), [])

  const statsThroughGameIds = useMemo(() => {
    if (!selectedGame) return tournamentGameIds
    const cutoff = gameOrderKey(selectedGame)
    return new Set(
      filteredGames
        .filter((g) => gameOrderKey(g) <= cutoff)
        .map((g) => String(g.id)),
    )
  }, [filteredGames, selectedGame, gameOrderKey, tournamentGameIds])

  const characterSeasonStats = useMemo(() => {
    if (!currentBatter) return null
    const tournPAs = plateAppearances.filter(pa =>
      pa.character_id === currentBatter.character_id &&
      statsThroughGameIds.has(String(pa.game_id)),
    )
    return summarizeBatting(tournPAs)
  }, [plateAppearances, currentBatter, statsThroughGameIds])

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
  // lineupDirtyRef is the source of truth read synchronously inside effects;
  // lineupDirty mirrors it in state so the Save button / unsaved-changes
  // guard (which need a reactive value) can read it too.
  const lineupDirtyRef = useRef({ A: false, B: false })
  const [lineupDirty, setLineupDirty] = useState({ A: false, B: false })
  const markLineupDirty = useCallback((team, value) => {
    lineupDirtyRef.current = { ...lineupDirtyRef.current, [team]: value }
    setLineupDirty((current) => ({ ...current, [team]: value }))
  }, [])
  // Tracks the last saved team_lineups payload seen for each team, so pregame
  // sync from Roster/SeasonRoster doesn't re-apply the same snapshot forever.
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
    setLineupDirty({ A: false, B: false })
    setLineupSaveStatus({ A: 'idle', B: 'idle' })
  }, [viewMode, selectedGame?.id])


  // Key-order-independent equality for a lineup draft, so comparing against
  // the freshly-rebuilt baseline isn't fooled by object insertion order.
  const lineupDraftKey = (draft) => JSON.stringify({
    order: draft.order,
    fielding: Object.keys(draft.fielding).sort().map((key) => [key, draft.fielding[key]]),
  })

  const handleLineupDragStart = useCallback((characterId) => (e) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('characterId', String(characterId))
    e.dataTransfer.setData('lineupCharacterId', String(characterId))
  }, [])

  const reorderLineupDraft = useCallback((team, characterId, targetIndex) => {
    setLineupDrafts((current) => {
      const order = swapLineupSlot(current[team].order, characterId, targetIndex)
      if (order === current[team].order) return current
      const nextDraft = { ...current[team], order }
      // Compare against the source-of-truth draft (not just "did this one
      // edit change something") so moving a slot and then moving it back
      // clears the dirty flag instead of leaving a false "unsaved changes".
      const baseline = buildLineupDraft(team)
      markLineupDirty(team, lineupDraftKey(nextDraft) !== lineupDraftKey(baseline))
      return { ...current, [team]: nextDraft }
    })
  }, [markLineupDirty, buildLineupDraft])

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
      const nextDraft = { ...current[team], fielding }
      const baseline = buildLineupDraft(team)
      markLineupDirty(team, lineupDraftKey(nextDraft) !== lineupDraftKey(baseline))
      return { ...current, [team]: nextDraft }
    })
  }, [markLineupDirty, buildLineupDraft])

  const setSelectedFieldingPlayerForTeam = useCallback((team) => (updater) => {
    setSelectedFieldingPlayer((current) => {
      const value = typeof updater === 'function' ? updater(current[team]) : updater
      return { ...current, [team]: value }
    })
  }, [])

  // Applies a lineup order + fielding assignment for `team` to the live
  // lineups/game_fielders projection for this specific game. The saved
  // team_lineups snapshot only seeds pregame state and is not rewritten here.
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

    // Only touch rows for positions actually present in this `fielding`
    // payload — leave every other position's existing row alone. Otherwise a
    // partial update (e.g. a mid-game pitcher change, which only ever sets
    // `fielding.pitcher`) would close/delete the *entire* defense down to
    // just that one position, since a stale/incomplete saved team_lineups
    // snapshot can legitimately have only one key in `fielding_positions`.
    const mentionedPositions = new Set(
      Object.entries(fielding).filter(([, characterId]) => characterId).map(([fieldId]) => FIELD_ID_TO_SCOREBOOK_POSITION[fieldId]),
    )
    const openRows = gameFielderRows.filter((r) => String(r.team_id) === String(teamId) && r.inning_to == null && mentionedPositions.has(r.position))
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
    // An empty `order` means this snapshot doesn't know the batting order at
    // all (e.g. a pitcher-only change) — leave the existing lineup rows
    // alone rather than blanking every character_id to order[idx]===undefined.
    if (order.length) {
      setLineups((current) => current.map((row) => {
        const idx = lineupRows.findIndex((r) => String(r.id) === String(row.id))
        if (idx === -1) return row
        return { ...row, character_id: order[idx], batting_order: idx + 1 }
      }))
    }
    setGameFielders((current) => [
      ...current
        .filter((row) => !deletedIds.has(String(row.id)))
        .map((row) => (closedIds.has(String(row.id)) ? { ...row, inning_to: Number(currentInning) - 1 } : row)),
      ...insertedFielderRows,
    ])

    if (!skipMirror) {
      // Mirror this save back into the shared team_lineups/season_team_lineups row so
      // Roster/SeasonRoster (and any other open Scorebook session) picks up a lineup or
      // fielding change made mid-game instead of only ever seeing it flow the other way
      // (team_lineups -> game, via applyIncomingTeamLineup above, and only pre-game at
      // that). Set the ref before awaiting the upsert so the realtime echo of our own
      // write can't turn around and re-apply itself as an "incoming" change.
      lastSyncedTeamLineupRef.current[team] = JSON.stringify({ lineupOrder: order, fieldingPositions: fielding })
      const sourceId = gameSession?.sourceId
      if (sourceId && order.length) {
        const teamLineupsTable = isSeasonGame ? SEASON_TEAM_LINEUPS : TOURNAMENT_TEAM_LINEUPS
        const { error: mirrorError } = await upsertTeamLineup({
          ...teamLineupsTable,
          sourceId,
          playerId,
          lineupOrder: order,
          fieldingPositions: fielding,
        })
        if (mirrorError) {
          pushToast({ title: 'Lineup saved, but roster sync failed', message: mirrorError.message, type: 'error' })
        }
      }
    }

    // If this team is currently on defense and the pitcher assignment
    // changed, record an actual pitching change so the mound, game view,
    // scorebook field diagram, and bets tab all update.
    const newPitcherCharId = fielding.pitcher ? Number(fielding.pitcher) : null
    if (newPitcherCharId && offense?.pitchingPlayerId === playerId && newPitcherCharId !== Number(currentPitcherStint?.character_id)) {
      await changePitcherRef.current?.(playerId, newPitcherCharId)
    }
  }, [selectedGame, teamAId, teamBId, teamALineup, teamBLineup, scorebookTables.lineups, scorebookTables.gameFielders, gameFielderRows, currentInning, playersById, charactersById, addSourceFields, pushToast, teamAName, teamBName, offense, currentPitcherStint, gameSession?.sourceId, isSeasonGame])

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
    // Only let saved team_lineups seed the live game projection before the game has
    // actually started. Once scoring or in-game pitcher changes begin, lineups/game_fielders
    // become the authoritative game-specific state and saved team_lineups stay as the pregame plan.
    if (canEditScorebook && !isGameComplete && gamePAs.length === 0 && (gameLineups.length === 0 || gameFielderRows.length === 0)) {
      // Guard against a stale/mismatched team_lineups snapshot (e.g. saved
      // for a different tournament round or before a trade/roster change)
      // ever clobbering this game's actual lineup. This poll/realtime sync
      // fires unconditionally the first time it sees a saved row (and on
      // every 5s tick after that), so without this check a snapshot whose
      // character ids aren't part of this team's *current in-game* lineup
      // gets written straight into lineups/game_fielders — and since those
      // ids don't resolve via charactersById, the whole fielding team (both
      // the lineup row and the field diagram, which read the resulting
      // character_id / character name respectively) renders as "?".
      const gameRosterIds = new Set((team === 'A' ? teamALineup : teamBLineup).map((row) => String(row.character_id)))
      const referencedIds = [...lineupOrder, ...Object.values(fieldingPositions)]
      const isKnownLineup = referencedIds.length > 0 && referencedIds.every((id) => gameRosterIds.has(String(id)))
      if (isKnownLineup) {
        applyLineupToGameRef.current?.(team, lineupOrder, fieldingPositions, { skipMirror: true })
      }
    }
  }, [canEditScorebook, gameFielderRows.length, gameLineups.length, gamePAs.length, isGameComplete, teamALineup, teamBLineup])

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
    // Skip the fallback poll's actual work while backgrounded — a background tab isn't the one
    // a browser needs to worry about here, and polling every 5s regardless of visibility keeps
    // the tab constantly "active," which is exactly what makes browsers reclaim it first when
    // freeing memory from inactive tabs. Resync immediately the moment the tab is shown again.
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') pollTeamLineups()
    }
    document.addEventListener('visibilitychange', handleVisibility)
    const pollInterval = setInterval(() => {
      if (document.hidden) return
      pollTeamLineups()
    }, 5000)

    return () => {
      supabase.removeChannel(channel)
      document.removeEventListener('visibilitychange', handleVisibility)
      clearInterval(pollInterval)
    }
  }, [gameSession?.sourceId, isSeasonGame, selectedGame?.team_a_player_id, selectedGame?.team_b_player_id, applyIncomingTeamLineup])

  // A pitcher swap made while a team was batting can't be applied to
  // pitching_stints right away (they're not the pitching team yet). Once
  // that team takes the mound, check their saved fielding.pitcher against
  // the active pitching stint and apply the change then.
  //
  // This must only run at the moment a team *transitions onto* defense —
  // not on every render where lineupDrafts/currentPitcherStint merely
  // change reference. Otherwise a manual mid-half pitcher change (which
  // updates currentPitcherStint) gets immediately fought and reverted back
  // to the saved lineup pitcher the next time lineupDrafts refreshes
  // (Lineups tab open, the 5s poll, realtime), since that's still the old
  // saved value.
  const prevDefensivePlayerIdRef = useRef(null)
  // Tracks whether we've observed a defensive side at all yet — without this,
  // the very first run after any remount (tab reload, navigating back to this
  // game) sees prevDefensivePlayerIdRef.current as null and misreads "the
  // team already on defense" as having "just taken the mound", which then
  // force-reverts an already-correct current pitcher back to whatever stale
  // fielding.pitcher happens to be sitting in lineupDrafts.
  const hasSeenDefensiveSideRef = useRef(false)
  useEffect(() => {
    if (!offense?.pitchingPlayerId || !canEditScorebook) return
    const justTookMound = hasSeenDefensiveSideRef.current && prevDefensivePlayerIdRef.current !== offense.pitchingPlayerId
    prevDefensivePlayerIdRef.current = offense.pitchingPlayerId
    hasSeenDefensiveSideRef.current = true
    if (!justTookMound) return
    const team = String(offense.pitchingPlayerId) === String(selectedGame?.team_a_player_id) ? 'A'
      : String(offense.pitchingPlayerId) === String(selectedGame?.team_b_player_id) ? 'B' : null
    if (!team) return
    const desiredPitcherCharId = lineupDrafts[team]?.fielding?.pitcher ? Number(lineupDrafts[team].fielding.pitcher) : null
    if (desiredPitcherCharId && desiredPitcherCharId !== Number(currentPitcherStint?.character_id)) {
      changePitcherRef.current?.(offense.pitchingPlayerId, desiredPitcherCharId)
    }
  }, [offense?.pitchingPlayerId, canEditScorebook, lineupDrafts, currentPitcherStint, selectedGame?.team_a_player_id, selectedGame?.team_b_player_id])

  // Lineup/fielding edits are saved explicitly via the Save button rather
  // than autosaved, to avoid races with realtime/poll updates from other
  // viewers clobbering in-flight edits. Other viewers' Lineups tabs pick
  // this up via the realtime subscriptions on `lineups`/`game_fielders`
  // (and rebuild their draft above) once saved.
  const handleSaveLineupTeam = useCallback(async (team) => {
    setLineupSaveStatus((current) => ({ ...current, [team]: 'saving' }))
    try {
      await saveTeamLineup(team)
      markLineupDirty(team, false)
      setLineupSaveStatus((current) => ({ ...current, [team]: 'saved' }))
    } catch (err) {
      setLineupSaveStatus((current) => ({ ...current, [team]: 'error' }))
      throw err
    }
  }, [saveTeamLineup, markLineupDirty])

  const handleSaveAllDirtyLineups = useCallback(async () => {
    const teams = ['A', 'B'].filter((team) => lineupDirtyRef.current[team])
    await Promise.all(teams.map((team) => handleSaveLineupTeam(team)))
  }, [handleSaveLineupTeam])

  // At-Bat Data Entry (the "exitVelo" tab) reports its own dirty state here
  // since its draft lives inside AtBatDataEntryPanel, not Scorebook — folded
  // into the same leave-page guard as lineup edits below. atBatPanelRef lets
  // the "Save & Leave" flow trigger that panel's save without lifting its
  // whole draft up into Scorebook.
  const atBatPanelRef = useRef(null)
  const inPlayDetailsFooterRef = useRef(null)
  const inPlayStageRef = useRef(null)

  useLayoutEffect(() => {
    const stage = inPlayState?.stage || null
    // Land directly on the BACK/CONFIRM row when the details step opens (no
    // animated scroll) so the scorekeeper isn't stuck scrolling past the
    // diamond/preview every play.
    if (stage === 'details' && inPlayStageRef.current !== 'details') {
      inPlayDetailsFooterRef.current?.scrollIntoView({ behavior: 'instant', block: 'end' })
      window.scrollBy({ top: 60, behavior: 'instant' })
    }
    inPlayStageRef.current = stage
  }, [inPlayState?.stage])
  const [atBatDataDirty, setAtBatDataDirty] = useState(false)

  const anyLineupDirty = lineupDirty.A || lineupDirty.B
  const anyUnsavedChanges = anyLineupDirty || atBatDataDirty
  const unsavedChangesMessage = anyLineupDirty && atBatDataDirty
    ? 'You have unsaved lineup/fielding changes and unsaved at-bat data changes. Save them before leaving, or discard them?'
    : atBatDataDirty
      ? 'You have unsaved at-bat data changes. Save them before leaving, or discard them?'
      : 'You have unsaved lineup/fielding changes. Save them before leaving, or discard them?'

  const handleSaveAllDirtyAndAtBat = useCallback(async () => {
    await handleSaveAllDirtyLineups()
    if (atBatDataDirty) await atBatPanelRef.current?.save?.()
  }, [handleSaveAllDirtyLineups, atBatDataDirty])

  // "Discard & Leave" must actively clear the dirty flags, not just let
  // navigation/view-mode proceed — the lineup-dirty reset effect above only
  // runs while viewMode === 'lineups', so leaving that tab (or the route)
  // without this would leave lineupDirty/atBatDataDirty stuck true forever,
  // re-triggering the unsaved-changes prompt on every subsequent navigation
  // even though there's nothing left to discard.
  const handleDiscardAllDirtyAndAtBat = useCallback(() => {
    lineupDirtyRef.current = { A: false, B: false }
    setLineupDirty({ A: false, B: false })
    setLineupDrafts({ A: buildLineupDraft('A'), B: buildLineupDraft('B') })
    if (atBatDataDirty) atBatPanelRef.current?.discard?.()
  }, [buildLineupDraft, atBatDataDirty])

  const lineupBlocker = useUnsavedChangesGuard(anyUnsavedChanges)
  useRegisterUnsavedChanges(anyUnsavedChanges, handleSaveAllDirtyAndAtBat)

  // Switching Scorebook's own tabs (Game View/Scorebook/Lineups/At-Bat Data/
  // Admin) is a same-page state change, not a router navigation, so the
  // route-level blocker above never sees it — this guards that path for
  // both lineup/fielding and At-Bat Data drafts (see viewTabs below).
  const { run: runViewChange, blocker: viewChangeBlocker } = useConfirmedAction(anyUnsavedChanges)

  const currentEntryKey = currentBatter ? `${currentBatter.player_id}:${currentBatter.character_id}` : null
  const lineupStatsByEntryKey = useMemo(() => {
    const next = {}
    gameLineups.forEach((entry) => {
      const key = `${entry.player_id}:${entry.character_id}`
      const gamePasForEntry = gamePAs.filter((pa) => String(pa.player_id) === String(entry.player_id) && Number(pa.character_id) === Number(entry.character_id))
      const sourcePasForEntry = plateAppearances.filter((pa) => statsThroughGameIds.has(String(pa.game_id)) && String(pa.player_id) === String(entry.player_id) && Number(pa.character_id) === Number(entry.character_id))
      const gameStats = summarizeBatting(gamePasForEntry, filterRunEventsForCharacter(gameRuns, entry.character_id, gamePasForEntry))
      const sourceStats = summarizeBatting(sourcePasForEntry, filterRunEventsForCharacter(runsScored, entry.character_id, sourcePasForEntry))
      next[key] = { game: gameStats, source: sourceStats }
    })
    return next
  }, [gameLineups, gamePAs, plateAppearances, statsThroughGameIds, gameRuns, runsScored])

  // Season/tournament-cumulative ERA for the Game View pitcher log — same
  // "as of this game" scope as lineupStatsByEntryKey's AVG/OBP/SLG above, just built
  // from stints instead of PAs since summarizePitching aggregates over stints.
  const pitchingSourceStatsByCharacterKey = useMemo(() => {
    const relevantStints = pitchingStints.filter((stint) => statsThroughGameIds.has(String(stint.game_id)))
    const grouped = {}
    relevantStints.forEach((stint) => {
      const key = `${stint.player_id}:${stint.character_id}`
      grouped[key] = grouped[key] || []
      grouped[key].push(stint)
    })
    return Object.fromEntries(
      Object.entries(grouped).map(([key, stints]) => [key, summarizePitching(stints)]),
    )
  }, [pitchingStints, statsThroughGameIds])

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
  const livePitchNumberIsRecoverable = Boolean(selectedGameLiveState)
    && (Number(selectedGameLiveState.balls || 0) > 0 || Number(selectedGameLiveState.strikes || 0) > 0)
    && (!selectedGameLiveState.pitcherStintId || String(selectedGameLiveState.pitcherStintId) === String(currentPitcherStint?.id))
  const displayPitchNumber = canEditScorebook
    ? pitchNumber
    : livePitchNumberIsRecoverable
      ? Math.max(Number(currentPitcherPitchRows.length), Number(selectedGameLiveState.pitchNumber ?? currentPitcherPitchRows.length))
      : Number(currentPitcherPitchRows.length)
  const displayOutsInHalf = canEditScorebook ? outsInHalf : Number(selectedGameLiveState?.outsInHalf ?? outsInHalf)
  const displayRunners = useMemo(() => {
    // The scorekeeper's own `runners` state is authoritative and always current —
    // it's never stale, so it should render as-is (including a runner an Admin
    // adds at the very start of a half, before any PA is recorded). The
    // start-of-half blanking below only guards against `selectedGameLiveState`,
    // which can lag a beat behind reality via realtime propagation and could
    // otherwise flash the previous half's runners for viewers.
    if (canEditScorebook) return runners
    const nextRunners = selectedGameLiveState?.runners || { first: null, second: null, third: null }
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
      allPAs: trackedPlateAppearances,
      allPitching: pitchingStints,
      stadiumsById,
      stadiumGameLog,
      playersById,
      currentInning,
      scores,
      totalInnings: regulationInnings,
      bets: gameBets,
      oddsWeights: oddsEngineWeights,
    })
  }, [
    selectedGame,
    draftPicks,
    charactersById,
    gamePAs,
    gamePitching,
    games,
    trackedPlateAppearances,
    pitchingStints,
    stadiumsById,
    stadiumGameLog,
    playersById,
    currentInning,
    scores,
    regulationInnings,
    gameBets,
    oddsEngineWeights,
  ])

  // estimateHomeWinProbability assumes "away" = team A and "home" = team B, with
  // `isTop` meaning the away team (team A) is batting. `offense.isTop` only tells
  // us whether it's structurally the top of the inning, which (when swapped) can
  // mean team B is batting — so derive isTop from which team is actually batting.
  const isTeamABatting = offense ? String(offense.battingPlayerId) === String(selectedGame?.team_a_player_id) : true
  // Which line-score row (away/home) reflects the half-inning currently being played —
  // null once the game is final, since no half is "active" anymore.
  const activeBattingSide = effectiveGameStatus === 'complete'
    ? null
    : (isTeamABatting === !homeAwaySwapped ? 'away' : 'home')
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
      const outsAfter = outsBefore + calculateOutsForPa(pa.result, pa.outs_on_play)
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

  const teamAExpectedPitcherId = lineupDrafts.A?.fielding?.pitcher ? Number(lineupDrafts.A.fielding.pitcher) : null
  const teamBExpectedPitcherId = lineupDrafts.B?.fielding?.pitcher ? Number(lineupDrafts.B.fielding.pitcher) : null

  const teamAPitching = useMemo(
    () => buildDisplayedPitchingStints(
      [...gamePitching].filter((stint) => String(stint.player_id) === String(selectedGame?.team_a_player_id)),
      selectedGame?.team_a_player_id,
      // The "expected pitcher" placeholder previews who's about to take the mound in a live
      // game — it should never appear on a completed game's box score, since lineupDrafts is
      // per-player state that can carry a stale planned-pitcher value long after the game ended.
      isGameComplete ? null : teamAExpectedPitcherId,
    ),
    [gamePitching, selectedGame?.team_a_player_id, teamAExpectedPitcherId, isGameComplete],
  )
  const teamBPitching = useMemo(
    () => buildDisplayedPitchingStints(
      [...gamePitching].filter((stint) => String(stint.player_id) === String(selectedGame?.team_b_player_id)),
      selectedGame?.team_b_player_id,
      isGameComplete ? null : teamBExpectedPitcherId,
    ),
    [gamePitching, selectedGame?.team_b_player_id, teamBExpectedPitcherId, isGameComplete],
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
      const localRestore = localActivePaRestoreRef.current
      const shouldApplyLocalRestore = localRestore
        && String(localRestore.gameId) === String(selectedGameId)
        && Number(localRestore.paNumber) === Number(activePaNumber)
        && String(localRestore.batterPlayerId) === String(currentBatter?.player_id)
        && String(localRestore.batterCharacterId) === String(currentBatter?.character_id)
      if (shouldApplyLocalRestore) {
        const restoredRows = Array.isArray(localRestore.paPitchRows) ? localRestore.paPitchRows : []
        const storedSnapshot = {
          scope: currentActivePaScope,
          pitcherKey: currentPitcherStorageKey,
          balls: Number(localRestore.balls || 0),
          strikes: Number(localRestore.strikes || 0),
          pitchNumber: Number(localRestore.pitchNumber || 0),
          paPitchRows: restoredRows,
          starHitUsed: false,
          starHitPending: false,
          starHitConnected: false,
          starPitchActive: false,
          pitchActionSheet: null,
          pendingPitchEvent: null,
          inPlayState: null,
          rbiOverlay: null,
        }
        sessionStorage.setItem(storageKey, JSON.stringify(storedSnapshot))
        setStarPitchActive(false)
        setPitchActionSheet(null)
        setPendingPitchEvent(null)
        paPitchRowsRef.current = restoredRows
        setPaPitchRows(restoredRows)
        setInPlayState(null)
        setRbiOverlay(null)
        setStarHitUsed(false)
        setStarHitPending(false)
        setStarHitConnected(false)
        restorePitchState(storedSnapshot)
        localActivePaRestoreRef.current = null
        setActivePaLoadedScope(currentActivePaScope)
        return
      }
      const raw = sessionStorage.getItem(storageKey)
      const parsed = raw ? JSON.parse(raw) : null
      // A local undo (reopenLastCompletedPA) deletes+refetches this PA's pitches to
      // reopen it mid-count, which changes currentPitcherPitchRows.length and re-runs
      // this very effect. The DB's live_state row hasn't caught up to the just-restored
      // count yet (it publishes on its own debounce), so trusting it here would clobber
      // the sessionStorage snapshot we just wrote with stale balls/strikes — hold off on
      // live-state hydration until that window passes.
      const withinLocalUndoHold = Date.now() < deferRealtimeUntilRef.current
      const shouldHydrateFromLiveState = !withinLocalUndoHold && selectedGameLiveState
        && (!selectedGameLiveState.batterPlayerId || String(selectedGameLiveState.batterPlayerId) === String(currentBatter?.player_id))
        && (!selectedGameLiveState.batterCharacterId || String(selectedGameLiveState.batterCharacterId) === String(currentBatter?.character_id))
      const committedPitchNumber = Number(currentPitcherPitchRows.length)
      const liveStateHasActivePitchCount = Number(selectedGameLiveState?.balls || 0) > 0
        || Number(selectedGameLiveState?.strikes || 0) > 0
      // A pitcher change (even mid-at-bat, via the Lineups tab or mound drag)
      // doesn't reset balls/strikes — the count belongs to the at-bat — but
      // it must reset the pitch counter, so this can't just piggyback on
      // shouldHydrateFromLiveState's batter-only check: the live_state row
      // being hydrated from may still reflect the *previous* pitcher's pitch
      // count if it hasn't been re-published since the change.
      const shouldHydratePitchNumberFromLiveState = shouldHydrateFromLiveState
        && (!selectedGameLiveState.pitcherStintId || String(selectedGameLiveState.pitcherStintId) === String(currentPitcherStint?.id))
        // A clean 0-0 live state only carries inning/runner context; its pitch
        // number is not needed for PA recovery and can be a stale value written
        // during a pitcher-change render. The committed pitch rows are the
        // authoritative baseline in that case.
        && liveStateHasActivePitchCount
      const livePitchNumber = Math.max(
        committedPitchNumber,
        Number(selectedGameLiveState?.pitchNumber ?? committedPitchNumber),
      )
      if (parsed?.scope === currentActivePaScope) {
        const shouldReuseStoredPitchCount = !shouldHydratePitchNumberFromLiveState && String(parsed.pitcherKey || '') === String(currentPitcherStorageKey)
        setStarPitchActive(Boolean(parsed.starPitchActive))
        setPitchActionSheet(parsed.pitchActionSheet || null)
        setPendingPitchEvent(parsed.pendingPitchEvent || null)
        const storedRows = Array.isArray(parsed.paPitchRows) ? parsed.paPitchRows : []
        paPitchRowsRef.current = storedRows
        setPaPitchRows(storedRows)
        setInPlayState(parsed.inPlayState || null)
        setRbiOverlay(parsed.rbiOverlay || null)
        setStarHitUsed(Boolean(parsed.starHitUsed))
        setStarHitPending(Boolean(parsed.starHitPending))
        setStarHitConnected(Boolean(parsed.starHitConnected))
        restorePitchState({
          balls: shouldHydrateFromLiveState ? Number(selectedGameLiveState.balls || 0) : Number(parsed.balls || 0),
          strikes: shouldHydrateFromLiveState ? Number(selectedGameLiveState.strikes || 0) : Number(parsed.strikes || 0),
          pitchNumber: shouldHydratePitchNumberFromLiveState
            ? livePitchNumber
            : shouldReuseStoredPitchCount
              ? Math.max(committedPitchNumber, Number(parsed.pitchNumber ?? committedPitchNumber))
              : committedPitchNumber,
        })
      } else {
        setStarPitchActive(false)
        setPitchActionSheet(null)
        setPendingPitchEvent(null)
        paPitchRowsRef.current = []
        setPaPitchRows([])
        setInPlayState(null)
        setRbiOverlay(null)
        setStarHitUsed(false)
        setStarHitPending(false)
        setStarHitConnected(false)
        restorePitchState({
          balls: shouldHydrateFromLiveState ? Number(selectedGameLiveState.balls || 0) : 0,
          strikes: shouldHydrateFromLiveState ? Number(selectedGameLiveState.strikes || 0) : 0,
          pitchNumber: shouldHydratePitchNumberFromLiveState
            ? livePitchNumber
            : committedPitchNumber,
        })
        if (!shouldHydrateFromLiveState) {
          sessionStorage.removeItem(storageKey)
        }
      }
    } catch {
      setStarPitchActive(false)
      setPitchActionSheet(null)
      setPendingPitchEvent(null)
      paPitchRowsRef.current = []
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
  }, [selectedGameId, currentActivePaScope, activePaNumber, currentPitcherPitchRows.length, currentPitcherStorageKey, currentPitcherStint?.id, restorePitchState, selectedGameLiveState, currentBatter?.player_id, currentBatter?.character_id])

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


  useEffect(() => {
    if (!selectedGameId) return
    // Wait for the game itself (and thus `offense`) to finish loading before
    // deciding what to hydrate — otherwise, right after a remount (e.g.
    // navigating away and back), `offense` is still null and neither the
    // sessionStorage cache nor the DB live_state can be trusted, so this
    // would fall back to empty runners and then permanently mark the scope
    // as loaded below, locking in the wrong (empty) state forever.
    if (!selectedGame || !offense) return
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
      const useStoredRunners = shouldTrustStoredRunners && stored && !shouldTrustLiveStateRunners
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
  }, [selectedGameId, currentHalfIdx, offense, selectedGame, selectedGameLiveState, runnerStateLoadedScope])

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
  const canRecordOutcome = Boolean(currentPitcherStint) && (!isSaving || isUndoInFlight) && !isPitchActionPending && canEditScorebook

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
    // Don't publish live_state until the runner-load effect has hydrated
    // `runners` for this game/half — otherwise this can race ahead of that
    // hydration, see the still-default empty runners, and write a bogus
    // "bases empty" live_state that clobbers real baserunners in the DB
    // (especially bad since a tab-hide/pagehide flush can send that
    // premature write immediately, bypassing the normal debounce).
    if (runnerStateLoadedScope !== `${selectedGameId}:${currentHalfIdx}`) return undefined

    const normalizedRunners = sanitizeRunnersForOffense(
      normalizeLiveRunners(runners),
      offense,
    )
    const hasLiveContext = hasAnyActiveRunners(normalizedRunners)
      // A clean out with nobody left on base (e.g. SF/SH scoring the runner
      // from 3B, or a bases-empty groundout) still needs live_state to
      // preserve the half-inning's current out count for reloads/spectators.
      || outsInHalf > 0
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
          pitcherStintId: currentPitcherStint?.id ?? null,
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
    currentPitcherStint,
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
    runnerStateLoadedScope,
    selectedGameId,
    currentHalfIdx,
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
    paPitchRowsRef.current = []
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

  const maxInning = useMemo(() => {
    const completedInnings = Math.ceil(completedHalfCount / 2)
    // A finished game shows only the innings actually played. `currentInning` (from
    // deriveOffense) always points at the *next* half-inning, so once the game is
    // complete it overshoots by one and must not be used here — fall back to the
    // recorded final_inning, or the count of completed innings, instead.
    if (effectiveGameStatus === 'complete') {
      const recordedFinalInning = Number(selectedGame?.final_inning)
      if (Number.isFinite(recordedFinalInning) && recordedFinalInning >= 1) return recordedFinalInning
      return Math.max(completedInnings, 1)
    }
    const highestPlayedInning = Math.max(currentInning, completedInnings, 1)
    return Math.max(regulationInnings, highestPlayedInning > regulationInnings ? highestPlayedInning : 0)
  }, [completedHalfCount, regulationInnings, currentInning, effectiveGameStatus, selectedGame?.final_inning])
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

  // Re-derive the game-end banner from persisted data once loaded. Without this,
  // a scorer who reloads (or reopens the tab) right after the last out — without
  // clicking Mark Complete/Continue Playing on the live banner — loses the
  // banner for good, since it otherwise only ever gets set as a one-off side
  // effect of confirming that specific play. Fires at the start of every half
  // inning (same condition the live path checks under), so it's a no-op except
  // when the completion condition was met but never acted on.
  useEffect(() => {
    if (!dataLoaded || !canEditScorebook || !selectedGame || isGameComplete || gameEndBanner) return
    if (outsInHalf !== 0 || currentHalfPaCount !== 0 || gamePAs.length === 0 || outsRecorded < 3) return
    if (dismissedGameEndOutsRef.current === outsRecorded) return
    // `offense` already rolled over to the upcoming half — re-derive the half
    // that just ended (same inputs the live confirm-handler saw) so isTop/inning
    // match what actually decided the game, not the phantom next at-bat.
    const endedHalfOffense = deriveOffense(selectedGame, outsRecorded - 3)
    const end = checkGameEnd({
      inning: endedHalfOffense.inning,
      isTop: endedHalfOffense.isTop,
      halfCompleted: true,
      currentScores: scores,
      previousScores: scores,
    })
    if (end) setGameEndBanner(end)
  }, [dataLoaded, canEditScorebook, isGameComplete, gameEndBanner, selectedGame, outsInHalf, currentHalfPaCount, gamePAs.length, outsRecorded, scores, checkGameEnd])

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
          const runs = getPaScoringRuns(pa)
          if (!runs) return acc
          const key = `${pa.inning}:${pa.player_id}`
          acc[key] = acc[key] || { inning: Number(pa.inning || 1), playerId: pa.player_id, runs: 0 }
          acc[key].runs += runs
          return acc
        }, {})

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

    await supabase.from(scorebookTables.inningScores).delete().eq('game_id', game.id)
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
      allPAs: trackedPlateAppearances,
      allPitching: pitchingStints,
      stadiumsById,
      stadiumGameLog,
      playersById,
      currentInning,
      scores,
      bets: gameBets,
      oddsWeights: oddsEngineWeights,
    })
  }, [
    charactersById,
    currentInning,
    gamePAs,
    gamePitching,
    draftPicks,
    games,
    pitchingStints,
    trackedPlateAppearances,
    playersById,
    scores,
    selectedGame,
    stadiumGameLog,
    stadiumsById,
    gameBets,
    oddsEngineWeights,
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
      oddsEngineWeights || DEFAULT_ODDS_WEIGHTS,
    )

    await upsertChangedOdds(generatedRows)
    return generatedRows
  }, [selectedGame, gamePitching, gamePAs, buildOddsGenerationContext, upsertChangedOdds, oddsEngineWeights])

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

  const recomputePitchingStatsForGame = useCallback(async (overridePAs, overridePitching = gamePitching, overrideRuns = gameRuns, overridePitches = gamePitches) => {
    if (!selectedGame || !overridePitching.length) return

    const stints = [...overridePitching].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    const pas = [...overridePAs].sort((a, b) => {
      const paA = Number(a.pa_number)
      const paB = Number(b.pa_number)
      const hasPaA = Number.isFinite(paA) && paA > 0
      const hasPaB = Number.isFinite(paB) && paB > 0
      if (hasPaA && hasPaB && paA !== paB) return paA - paB
      if (hasPaA !== hasPaB) return hasPaA ? -1 : 1
      return new Date(a.created_at) - new Date(b.created_at) || Number(a.id || 0) - Number(b.id || 0)
    })
    const nextStatsByStintId = Object.fromEntries(
      stints.map((stint) => [stint.id, {
        innings_pitched: 0,
        hits_allowed: 0,
        runs_allowed: 0,
        earned_runs: 0,
        walks: 0,
        strikeouts: 0,
        hr_allowed: 0,
        pitches_thrown: 0,
        strikes_thrown: 0,
        _outsRecorded: 0,
      }]),
    )

    let outsBeforePa = 0
    pas.forEach((pa) => {
      const defense = deriveOffense(selectedGame, outsBeforePa)
      // Prefer the pitcher recorded directly on the PA at save time (see savePA's pitcher_id/
      // pitcher_player_id) — it's authoritative regardless of row insertion order. Falling back
      // to "most recent stint created before this PA" breaks for bulk-imported/backfilled games,
      // where every stint's created_at can land after every PA's (all stints inserted in one
      // batch once the whole game was already recorded), silently zeroing out real box scores.
      let activeStint = null
      if (pa.pitcher_id != null) {
        // A pitcher who re-enters after being pulled gets a second stints row
        // with the same character_id/player_id — plain .find() would always
        // grab the earliest one, dumping every PA from the second outing back
        // onto the first and leaving the re-entry stint's stats stuck at 0.
        // Disambiguate by which of the same-pitcher stints was actually open
        // when this PA happened; only fall back to the earliest match when
        // none qualify (the bulk-import case the comment above describes).
        const candidateStints = stints.filter((stint) => (
          String(stint.character_id) === String(pa.pitcher_id) && String(stint.player_id) === String(defense.pitchingPlayerId)
        ))
        const eligibleCandidates = candidateStints.filter((stint) => (
          new Date(stint.created_at).getTime() <= new Date(pa.created_at).getTime()
        ))
        activeStint = eligibleCandidates[eligibleCandidates.length - 1] || candidateStints[0] || null
      }
      if (!activeStint) {
        const eligibleStints = stints.filter(
          (stint) =>
            String(stint.player_id) === String(defense.pitchingPlayerId) &&
            new Date(stint.created_at).getTime() <= new Date(pa.created_at).getTime(),
        )
        activeStint = eligibleStints[eligibleStints.length - 1]
      }
      if (activeStint) {
        const next = nextStatsByStintId[activeStint.id]
        const outs = calculateOutsForPa(pa.result, pa.outs_on_play)
        const paRuns = overrideRuns.filter((run) => String(run.pa_id) === String(pa.id))

        next._outsRecorded += outs
        if (HIT_RESULTS.has(pa.result)) next.hits_allowed += 1
        if (isHomeRunResult(pa.result)) next.hr_allowed += 1
        if (pa.result === 'BB') next.walks += 1
        if (pa.result === 'K') next.strikeouts += 1
        // Every pitch of this PA belongs to whichever stint the PA itself was
        // attributed to above — reuses that same re-entry-aware resolution
        // rather than re-deriving it per pitch from the pitches table's own
        // pitcher_id (a character name, not the id these stints key off of).
        const paPitches = overridePitches.filter((pitch) => String(pitch.pa_id) === String(pa.id))
        next.pitches_thrown += paPitches.length
        // A "strike" for the PC-ST count is every pitch except a ball or a hit
        // batsman — called/swinging strikes, fouls, and balls put in play all count.
        next.strikes_thrown += paPitches.filter((pitch) => pitch.result !== 'ball' && pitch.result !== 'hbp').length

        if (paRuns.length > 0) {
          paRuns.forEach((run) => {
            let target = next
            if (Number(run.charged_to_pitcher_id) !== Number(activeStint.character_id)) {
              // Inherited runner from a different pitcher: find their most recent stint before this PA.
              const chargedStints = stints.filter(
                (s) => Number(s.character_id) === Number(run.charged_to_pitcher_id) &&
                  new Date(s.created_at).getTime() <= new Date(pa.created_at).getTime()
              )
              const chargedStint = chargedStints[chargedStints.length - 1]
              if (chargedStint) target = nextStatsByStintId[chargedStint.id]
            }
            target.runs_allowed += 1
            if (run.is_earned_run !== false) target.earned_runs += 1
          })
        } else {
          // No runsScored rows (legacy savePA path): fall back to PA fields, charge active pitcher.
          const fallbackRuns = getPaScoringRuns(pa)
          if (fallbackRuns > 0) {
            next.runs_allowed += fallbackRuns
            if (pa.is_earned_run !== false) next.earned_runs += fallbackRuns
          }
        }
      }
      outsBeforePa += calculateOutsForPa(pa.result, pa.outs_on_play)
    })

    Object.values(nextStatsByStintId).forEach((entry) => {
      entry.innings_pitched = inningsPitchedFromOuts(entry._outsRecorded)
      delete entry._outsRecorded
    })

    // Always resend every stint's full stats rather than diffing against the
    // locally cached values and skipping writes that "look" unchanged: the
    // local cache gets optimistically updated below regardless of whether the
    // database write actually lands, so a single dropped/failed update would
    // make a diff check think the row is already correct and skip it forever
    // after — silently freezing that pitcher's stats in the database even
    // though the UI still shows the right numbers locally.
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
  }, [selectedGame, gamePitching, gameRuns, gamePitches])

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

  // ── Merged runner plan (runner placement panel) ────────────────────────────
  // Recomputes live as the fielder chain/trajectory change (same prediction
  // logic as before), then layers any manual destination overrides on top so
  // those survive further fielder taps until the scorer changes them again.
  const runnerPlanBaseline = useMemo(() => {
    if (!inPlayState) return []
    const batterRunner = buildBatterRunner(inPlayState.resultType === 'error')
    const baseline = computeBaselineRunnerAssignments(inPlayState, runners, batterRunner)
    return buildRunnerEntriesFromAssignments(baseline, runners)
  }, [inPlayState, runners, buildBatterRunner])

  const runnerPlan = useMemo(() => {
    const overrides = inPlayState?.manualRunnerPositions || {}
    return runnerPlanBaseline.map((entry) => (overrides[entry.id] ? { ...entry, ...overrides[entry.id] } : entry))
  }, [runnerPlanBaseline, inPlayState?.manualRunnerPositions])

  const updateRunnerPlanManual = useCallback((updater) => {
    setInPlayState((current) => {
      if (!current) return current
      const nextEntries = updater(runnerPlan, runners)
      const manualRunnerPositions = {}
      nextEntries.forEach((entry) => {
        const baselineEntry = runnerPlanBaseline.find((e) => e.id === entry.id)
        if (!baselineEntry) return
        if (baselineEntry.position !== entry.position || baselineEntry.outSource !== entry.outSource || baselineEntry.preOutPosition !== entry.preOutPosition) {
          manualRunnerPositions[entry.id] = { position: entry.position, outSource: entry.outSource, preOutPosition: entry.preOutPosition, manual: true }
        }
      })
      return { ...current, manualRunnerPositions }
    })
  }, [runnerPlan, runnerPlanBaseline, runners])

  const handleRunnerSetPosition = useCallback((id, position) => (
    updateRunnerPlanManual((entries) => applyManualRunnerDestination(entries, id, position))
  ), [updateRunnerPlanManual])

  // Live preview of the base state implied by the runner-placement panel's
  // current selections, shown on the runner-placement screen so the
  // scorekeeper can see the result before hitting Confirm.
  const runnerPlacementPreview = useMemo(() => {
    if (!inPlayState || inPlayState.stage !== 'details') return null
    const preview = { first: null, second: null, third: null }
    runnerPlan.forEach((entry) => {
      if (['first', 'second', 'third'].includes(entry.position) && entry.runner?.characterId) {
        preview[entry.position] = { characterId: entry.runner.characterId }
      }
    })
    return preview
  }, [inPlayState, runnerPlan])

  // Same geometry guess finalizeInPlay uses to auto-flag a Buddy Jump as a HR
  // rob (generic field marker for whoever made the catch vs. the stadium's wall
  // distance at that angle) — recomputed live here so the HR ROB toggle below
  // can show the current best guess before the scorekeeper corrects it.
  const buddyJumpAutoRobbedHr = useMemo(() => {
    if (!inPlayState?.isBuddyJump) return false
    const fielderChain = inPlayState.fielderChain || []
    const primaryPosition = fielderChain[1] || fielderChain[0] || null
    const stadiumConfig = stadiumKey ? STADIUM_CONFIGS[stadiumKey] : null
    if (!primaryPosition || !stadiumConfig) return false
    const spot = getFielderFieldSpot(primaryPosition, stadiumConfig)
    if (!spot) return false
    const rawHitDistanceFt = estimateHitDistance(spot, stadiumConfig)
    const hitAngleDeg = estimateHitAngle(spot, stadiumConfig)
    if (rawHitDistanceFt == null || hitAngleDeg == null) return false
    const wallDistanceFt = estimateWallDistanceAtAngle(hitAngleDeg, stadiumConfig)
    if (wallDistanceFt == null) return false
    return rawHitDistanceFt >= wallDistanceFt - ROBBED_HR_WALL_MARGIN_FT
  }, [inPlayState?.isBuddyJump, inPlayState?.fielderChain, stadiumKey])

  const buddyJumpEffectiveRobbedHr = inPlayState?.robbedHrOverride ?? buddyJumpAutoRobbedHr

  const buildRunEvent = useCallback((runner, earnedOverride) => {
    if (!runner?.characterId || !runner?.playerId) return null
    return {
      playerId: runner.playerId,
      characterId: runner.characterId,
      chargedToPitcherId: runner.chargedToPitcherId,
      chargedToPitcherPlayerId: runner.chargedToPitcherPlayerId,
      isEarnedRun: earnedOverride ?? (!inningExtendedByError && !runner.reachedOnError),
    }
  }, [inningExtendedByError])

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
    // A fielder's choice is the one batted-ball out-resolution result that can
    // legitimately record zero outs — the defense went for a runner elsewhere
    // (or would have had the batter at first) and nobody ended up retired.
    if (pending.outResolution && outAssignments.length < 1 && resolvedResult !== 'FC') {
      pushToast({ title: 'Missing out', message: 'This play needs at least one out assigned before it can be saved.', type: 'error' })
      return false
    }
    if (pending.outResolution && outAssignments.length > 3) {
      pushToast({ title: 'Too many outs', message: 'Only one, two, or three outs can be recorded on a single play.', type: 'error' })
      return false
    }
    const { result, assignments, paMeta = {}, pitchRows = paPitchRowsRef.current } = pending
    const creditedAssignments = wipeRunsOnPlay ? [] : assignments
    const runEvents = creditedAssignments
      .filter((assignment) => assignment.destination === 'home')
      .map((assignment) => buildRunEvent(assignment.runner, paMeta.isEarnedRun))
      .filter(Boolean)
    // No RBI on a fielder's choice — same rule as ROE — even when a run scores on the
    // same play, unless the batter is charged an error credit elsewhere (isError handles that).
    const finalRbi = (result === 'ROE' || resolvedResult === 'FC') ? 0 : getRbiFromAssignments(creditedAssignments)
    // Push the new base state synchronously, before awaiting the save, rather than after.
    // saveEnhancedPA updates `gamePAs` (which currentBatter/activePaNumber are derived from)
    // partway through its own work, then goes on to await several more network round-trips
    // (betting/odds resolution, score/inning sync) before this await resolves. If `runners`
    // only changed once all of that finished, there'd be a window — sometimes 1-2 seconds —
    // where the live-state-publish effect sees the NEW batter alongside the OLD runners, and
    // persists that inconsistent snapshot to season_schedule.live_state. If the tab closes or
    // loses connection in that window (e.g. a scorekeeper locking their phone right after
    // tapping Confirm), the stale snapshot is what every future session hydrates from — a
    // runner who already scored/advanced reappears on their old base. Every other save path
    // (BB/HBP/HR/SF/SH/outs) already calls saveEnhancedPA without awaiting it first, which
    // keeps pushRunners in the same synchronous tick — mirror that ordering here.
    if (!inningEndsOnThisPlay) pushRunners(extractNextRunners(pending))
    await saveEnhancedPA({
      result: resolvedResult || result,
      rbi: finalRbi,
      runScored: !wipeRunsOnPlay && didBatterScore(assignments),
      pitchRows,
      runEvents,
      // The authoritative out count for this play — covers a runner put out
      // on the bases during an otherwise-safe hit/error, which the result
      // code alone (calculateOutsForPa) can't see.
      outsOnPlay: outAssignments.length,
      ...paMeta,
      // paMeta.starHitRbi is a placeholder 0 set before runners were resolved (see the
      // NEEDS_RESOLUTION branch that builds pendingPA) — the real RBI is only known now, once
      // this play's runner assignments are final. starHitResult is only non-null when this PA
      // actually used a star hit, so that's the signal for whether to credit it here.
      starHitRbi: paMeta.starHitResult != null ? finalRbi : 0,
      isOfficialAb: pending.outResolution ? !['SF', 'SH'].includes(resolvedResult) : paMeta.isOfficialAb,
      fielderChoiceOut: pending.outResolution ? resolvedResult === 'FC' : paMeta.fielderChoiceOut,
      nextRunners: inningEndsOnThisPlay ? { first: null, second: null, third: null } : extractNextRunners(pending),
    })
    return true
  }, [canEditScorebook, currentBatter, buildRunEvent, saveEnhancedPA, pushRunners, pushToast, selectionOutsInHalf])

  const confirmPendingPA = useCallback(async () => {
    if (!pendingPA) return
    const committed = await commitPendingPA(pendingPA)
    if (committed) setPendingPA(null)
  }, [pendingPA, commitPendingPA])

  // A correction tap may arrive before the two delete requests behind Undo
  // finish. Keep the first tap instead of dropping it behind the save lock;
  // it will be dispatched against the restored batter/count as soon as the
  // local undo snapshot is installed.
  const queueCorrectionDuringUndo = useCallback((action) => {
    if (!undoInFlightRef.current) return false
    if (!queuedUndoCorrectionRef.current) {
      queuedUndoCorrectionRef.current = action
      setQueuedUndoCorrection(action)
    }
    return true
  }, [])

  const appendPitchEvent = useCallback((event) => {
    if (!event) return event
    clearRedoAction()
    const enrichedEvent = {
      ...event,
      // Balls + strikes is not a pitch count once a batter fouls pitches off
      // with two strikes. The synchronous row ref is the real PA sequence.
      pitchNumberPa: paPitchRowsRef.current.length + 1,
      pitcherCharacterId: currentPitcherStint?.character_id || null,
      pitcherPlayerId: currentPitcherStint?.player_id || null,
      pitcherId: currentPitcherChar?.name || '',
      pitcherPlayer: playersById[currentPitcherStint?.player_id]?.name || '',
    }
    paPitchRowsRef.current = [...paPitchRowsRef.current, enrichedEvent]
    setPaPitchRows(paPitchRowsRef.current)
    setStarPitchActive(false)
    return enrichedEvent
  }, [clearRedoAction, currentPitcherChar?.name, currentPitcherStint?.character_id, currentPitcherStint?.player_id, playersById])

  // star_pitch_used marks whether the star pitch was the DECISIVE pitch of the at-bat
  // (the one that ended it — walk/K/HBP/in-play). A star pitch fouled off or taken for
  // a ball/strike earlier in the count still counts toward that pitch's own is_star_pitch
  // flag (and the used/ball/strike tallies in summarizeStarPitching, which read straight
  // off the pitch log), but doesn't count toward "vs Star Pitch" outcome stats (AVG, HR,
  // success rate) unless it's actually what the batter put in play or struck out on.

  const handlePitchBall = useCallback(() => {
    if (queueCorrectionDuringUndo({ type: 'ball' })) return
    if (!canEditScorebook || pitchActionPendingRef.current || isSavingRef.current) return
    if (starHitUsed) return
    pitchActionPendingRef.current = true
    const pitchEvent = appendPitchEvent(recordBall(starPitchActive))
    if (!pitchEvent) {
      pitchActionPendingRef.current = false
      return
    }
    if (!pitchEvent.completedPa) {
      pitchActionPendingRef.current = false
      syncLiveOddsForCount(pitchEvent.pitch.count_balls_after, pitchEvent.pitch.count_strikes_after)
      return
    }
    lockPitchActions()

    const batterRunner = buildBatterRunner(false)
    const pending = computePendingState('BB', runners, batterRunner)
    const runEvents = getHomeAssignments(pending)
      .map((assignment) => buildRunEvent(assignment.runner))
      .filter(Boolean)
    saveEnhancedPA({
      result: 'BB',
      rbi: getRbiFromAssignments(pending.assignments),
      runScored: didBatterScore(pending.assignments),
      pitchRows: paPitchRowsRef.current,
      isOfficialAb: false,
      starPitchUsed: starPitchActive,
      runEvents,
      nextRunners: extractNextRunners(pending),
    })
    pushRunners(extractNextRunners(pending))
  }, [canEditScorebook, recordBall, starPitchActive, appendPitchEvent, buildBatterRunner, runners, saveEnhancedPA, pushRunners, starHitUsed, buildRunEvent, syncLiveOddsForCount, lockPitchActions, queueCorrectionDuringUndo])

  const handlePitchFoul = useCallback(() => {
    if (queueCorrectionDuringUndo({ type: 'foul' })) return
    if (!canEditScorebook || pitchActionPendingRef.current || isSavingRef.current) return
    pitchActionPendingRef.current = true
    const usedStarHitOnPitch = starHitUsed
    const pitchEvent = appendPitchEvent(recordFoul(starPitchActive))
    pitchActionPendingRef.current = false
    if (!pitchEvent) return
    if (usedStarHitOnPitch) {
      setStarHitPending(true)
      setStarHitConnected(true)
      setStarHitUsed(false)
    }
    syncLiveOddsForCount(pitchEvent.pitch.count_balls_after, pitchEvent.pitch.count_strikes_after)
  }, [canEditScorebook, recordFoul, starPitchActive, appendPitchEvent, starHitUsed, syncLiveOddsForCount, queueCorrectionDuringUndo])

  const handlePitchHbp = useCallback(() => {
    if (queueCorrectionDuringUndo({ type: 'hbp' })) return
    if (!canEditScorebook || pitchActionPendingRef.current || isSavingRef.current) return
    if (starHitUsed) return
    pitchActionPendingRef.current = true
    const pitchEvent = appendPitchEvent(recordHbp(starPitchActive))
    if (!pitchEvent) {
      pitchActionPendingRef.current = false
      return
    }
    lockPitchActions()
    const batterRunner = buildBatterRunner(false)
    const pending = computePendingState('HBP', runners, batterRunner)
    const runEvents = getHomeAssignments(pending)
      .map((assignment) => buildRunEvent(assignment.runner))
      .filter(Boolean)
    saveEnhancedPA({
      result: 'HBP',
      rbi: getRbiFromAssignments(pending.assignments),
      runScored: didBatterScore(pending.assignments),
      pitchRows: paPitchRowsRef.current,
      isOfficialAb: false,
      starPitchUsed: starPitchActive,
      runEvents,
      nextRunners: extractNextRunners(pending),
    })
    pushRunners(extractNextRunners(pending))
  }, [canEditScorebook, recordHbp, starPitchActive, appendPitchEvent, buildBatterRunner, runners, saveEnhancedPA, pushRunners, starHitUsed, buildRunEvent, lockPitchActions, queueCorrectionDuringUndo])

  const handleStrikeChoice = useCallback((type) => {
    if (queueCorrectionDuringUndo({ type: 'strike', strikeType: type })) return
    if (!canEditScorebook || pitchActionPendingRef.current || isSavingRef.current) return
    pitchActionPendingRef.current = true
    const usedStarHitOnPitch = starHitUsed
    const pitchEvent = appendPitchEvent(recordStrike(type, starPitchActive))
    if (!pitchEvent) {
      pitchActionPendingRef.current = false
      return
    }
    if (usedStarHitOnPitch) {
      setStarHitPending(true)
      setStarHitUsed(false)
    }
    setPitchActionSheet(null)
    if (!pitchEvent.completedPa) {
      pitchActionPendingRef.current = false
      syncLiveOddsForCount(pitchEvent.pitch.count_balls_after, pitchEvent.pitch.count_strikes_after)
      return
    }
    lockPitchActions()
    saveEnhancedPA({
      result: 'K',
      strikeoutType: pitchEvent.completedPa.strikeoutType,
      pitchRows: paPitchRowsRef.current,
      starPitchUsed: starPitchActive,
      starHitResult: usedStarHitOnPitch || starHitPending ? 'Out' : null,
    })
    // A strikeout doesn't move any runners, but undo (reopenLastCompletedPA/undoLastPA)
    // pops exactly one runnersHistory entry per completed PA — without this push here,
    // that pop would land on the snapshot from an earlier PA instead, silently dropping
    // whichever runner reached base since then.
    pushRunners({ ...runners })
  }, [canEditScorebook, recordStrike, starPitchActive, appendPitchEvent, saveEnhancedPA, starHitPending, starHitUsed, syncLiveOddsForCount, lockPitchActions, pushRunners, runners, queueCorrectionDuringUndo])

  const handlePitchInPlay = useCallback(() => {
    if (queueCorrectionDuringUndo({ type: 'in_play' })) return
    if (!canEditScorebook || pitchActionPendingRef.current || isSavingRef.current) return
    // "In play" ends the pitch immediately, but the scorer may still back out of
    // the provisional result picker. Keep a pre-pitch snapshot so backing out
    // restores count + pitch history instead of leaking phantom pitches.
    // pitchActionPendingRef stays true until finalizeInPlay saves or cancelInPlaySelection rolls back.
    pitchActionPendingRef.current = true
    const rollbackSnapshot = buildActivePaSnapshot()
    const usedStarHitOnPitch = starHitUsed
    const pitchEvent = appendPitchEvent(recordInPlay(starPitchActive))
    if (!pitchEvent) {
      pitchActionPendingRef.current = false
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
      pitchRows: paPitchRowsRef.current,
      usedStarHit: usedStarHitOnPitch || starHitPending,
      resultType: null,
      result: null,
      trajectory: null,
      fielderChain: [],
      rollbackSnapshot,
    })
  }, [canEditScorebook, buildActivePaSnapshot, recordInPlay, starPitchActive, appendPitchEvent, starHitPending, starHitUsed, queueCorrectionDuringUndo])

  const finalizeInPlay = useCallback(async (state) => {
    if (!canEditScorebook || !canFinalizeInPlaySelection(state, activeDefensiveFielders)) return
    // Freeze the build-the-play/runner-placement UI the instant a save starts.
    // commitPendingPA below pushes the new base state synchronously, ahead of
    // its awaited saveEnhancedPA call — if the details screen were still live
    // at that point, runnerPlan would recompute against the *new* runners
    // (which already has the batter on base) while inPlayState/state still
    // describe the play that just put them there, so the batter would
    // briefly render twice: once as themselves, once as the "runner" they
    // just became. Leaving the 'details' stage suppresses that render until
    // inPlayState is cleared for good below.
    setInPlayState((current) => (current ? { ...current, stage: 'submitting' } : current))
    const usedStarHit = Boolean(state.usedStarHit || starHitPending || starHitUsed)
    const fielderChain = state.fielderChain || []
    // A Buddy Jump's chain is [assist, putout] — the second fielder tapped is
    // the one who actually made the catch, reversing the usual "last fielder
    // in the chain = putout" convention used for grounders/relays elsewhere.
    const primaryPosition = state.result === 'HR'
      ? null
      : (state.isBuddyJump ? (fielderChain[1] || fielderChain[0] || null) : (fielderChain[0] || null))
    const notation = state.result === 'HR'
      ? ''
      : (primaryPosition ? assembleNotation(state.trajectory, fielderChain) : '')
    const batterRunner = buildBatterRunner(state.resultType === 'error')
    const stadiumConfig = stadiumKey ? STADIUM_CONFIGS[stadiumKey] : null
    // The scorekeeper only marks who touched the ball live — the fielder's
    // position on the field diagram stands in as the effective landing spot.
    // Precise location (and home run direction/distance) is added later in
    // At-Bat Data Entry.
    const effectiveLandingSpot = primaryPosition ? getFielderFieldSpot(primaryPosition, stadiumConfig) : null
    const rawHitDistanceFt = effectiveLandingSpot ? estimateHitDistance(effectiveLandingSpot, stadiumConfig) : null
    const hitAngleDeg = effectiveLandingSpot ? estimateHitAngle(effectiveLandingSpot, stadiumConfig) : null
    const direction = resolveBattedBallDirection(primaryPosition, hitAngleDeg, currentBatterHandedness)
    // A Buddy Jump catch near the fence is a candidate home run robbery — the
    // tapped catch point understates true distance since the ball was caught
    // before it could keep carrying, so exit velocity would read low if we
    // stored the raw catch-point distance for these plays.
    const wallDistanceFt = state.isBuddyJump && hitAngleDeg != null && stadiumConfig
      ? estimateWallDistanceAtAngle(hitAngleDeg, stadiumConfig)
      : null
    const geometryRobbedHr = Boolean(
      state.isBuddyJump && wallDistanceFt != null && rawHitDistanceFt != null
      && rawHitDistanceFt >= wallDistanceFt - ROBBED_HR_WALL_MARGIN_FT,
    )
    // The geometry estimate is only a guess based on the fielder's generic field
    // marker, not the actual catch point — the HR ROB toggle on the details screen
    // lets the scorekeeper confirm or correct it before saving.
    const isRobbedHr = state.isBuddyJump ? (state.robbedHrOverride ?? geometryRobbedHr) : false
    const hitDistanceFt = isRobbedHr ? wallDistanceFt + ROBBED_HR_CARRY_FT : rawHitDistanceFt
    const buddyJumpFields = state.isBuddyJump ? {
      isBuddyJump: true,
      buddyJumpAssistPosition: fielderChain[0] || null,
      buddyJumpPutoutPosition: fielderChain[1] || null,
      isRobbedHr,
    } : {}

    if (isHomeRunResult(state.result)) {
      const runnersToScore = [runners.first, runners.second, runners.third, batterRunner].filter(Boolean)
      await saveEnhancedPA({
        result: state.result,
        rbi: runnersToScore.length,
        runScored: true,
        trajectory: state.trajectory,
        hitLocation: primaryPosition,
        hitNotation: notation,
        direction,
        landingSpot: effectiveLandingSpot,
        hitDistanceFt,
        hitAngleDeg,
        pitchRows: state.pitchRows,
        // Each runner's own reachedOnError flag (set when they originally reached base)
        // decides earned status here — a runner who reached on an earlier error is still
        // unearned when a teammate's clean home run brings them home.
        runEvents: runnersToScore.map((runner) => buildRunEvent(runner)).filter(Boolean),
        starPitchUsed: state.pitchEvent?.pitch?.is_star_pitch,
        starHitResult: usedStarHit ? state.result : null,
        starHitRbi: usedStarHit ? runnersToScore.length : 0,
        nextRunners: { first: null, second: null, third: null },
      })
      pushRunners({ first: null, second: null, third: null })
      return
    }

    // Runner placement for every non-HR in-play result is decided on the
    // merged build-the-play + runner-placement screen (runnerPlan, defaulted
    // to the auto-detected placement and optionally overridden by the scorer) —
    // finalizeInPlay just converts that plan into assignments and commits.
    const planAssignments = runnerPlan.map((entry) => buildPendingAssignment(
      entry.id, entry.runner, entry.origin, entry.position, entry.id === 'batter',
    ))

    // Every fielder charged with an error on this play, regardless of result
    // type — a clean hit/out that a fielder then booted still scores as that
    // hit/out (1B, GO, whatever), the ERROR toggle just layers error credit
    // onto whoever was tapped while it was on. A ROE with nothing explicitly
    // marked still defaults to the first fielder in the chain (see
    // effectiveErrorPositions), since ROE is an error by definition. is_error
    // is independent of `result` throughout the stats pipeline, so this
    // credits each fielder's error and zeroes RBI/earned-run status for the
    // play without misclassifying it as a different result.
    const errorPositions = effectiveErrorPositions(state)
    const primaryErrorPosition = errorPositions[0] || null
    const primaryErrorFielder = primaryErrorPosition ? activeDefensiveFielders[primaryErrorPosition] : null
    const errorFields = errorPositions.length ? {
      isError: true,
      errorPosition: primaryErrorPosition,
      errorCharacter: primaryErrorFielder?.character || null,
      errorPlayer: primaryErrorFielder?.player_name || null,
      isEarnedRun: false,
    } : {}
    const isNicePlay = Boolean(state.nicePlay && fielderChain[0])

    if (state.resultType === 'hit' && NEEDS_RESOLUTION.has(state.result)) {
      // Imply the putout fielder for any runner thrown out advancing on this hit — see
      // BASE_COVERING_POSITION. Appending it after fielderChain makes it the notation's
      // last (putout) fielder, downgrading whoever actually touched the ball to an assist.
      const runnerOutCoveringPositions = runnerPlan
        .filter((entry) => entry.id !== 'batter' && entry.position === 'out')
        .map((entry) => BASE_COVERING_POSITION[entry.preOutPosition])
        .filter(Boolean)
      const hitFielderChain = [...fielderChain, ...runnerOutCoveringPositions]
      const hitNotation = errorPositions.length
        ? assembleErrorNotation(state.trajectory, hitFielderChain, errorPositions)
        : assembleNotation(state.trajectory, hitFielderChain)
      const pending = {
        result: state.result,
        assignments: planAssignments,
        pitchRows: state.pitchRows,
        rollbackSnapshot: state.rollbackSnapshot || null,
        paMeta: {
          trajectory: state.trajectory,
          hitLocation: primaryPosition,
          hitNotation,
          direction,
          landingSpot: effectiveLandingSpot,
          hitDistanceFt,
          hitAngleDeg,
          starPitchUsed: state.pitchEvent?.pitch?.is_star_pitch,
          starHitResult: usedStarHit ? state.result : null,
          starHitRbi: usedStarHit ? 0 : 0,
          isNicePlay,
          ...errorFields,
        },
      }
      const committed = await commitPendingPA(pending)
      if (committed) {
        setInPlayState(null)
      } else {
        // commitPendingPA rejects (runner conflict / missing or too many outs)
        // via a toast + early return, without ever reaching saveEnhancedPA — so
        // nothing else unlocks the pitch actions or the 'submitting' stage this
        // function set above. Left as-is, the details/confirm panel never comes
        // back (nothing renders for 'submitting') and every other pitch button
        // stays disabled until a full page refresh. Send the scorer back to the
        // details screen so they can fix the assignment and retry.
        setInPlayState((current) => (current ? { ...current, stage: 'details' } : current))
      }
      return
    }

    if (state.resultType === 'error') {
      const pending = {
        result: 'ROE',
        assignments: planAssignments,
        pitchRows: state.pitchRows,
        rollbackSnapshot: state.rollbackSnapshot || null,
        paMeta: {
          trajectory: state.trajectory,
          hitLocation: primaryPosition,
          hitNotation: notation,
          direction,
          landingSpot: effectiveLandingSpot,
          hitDistanceFt,
          hitAngleDeg,
          errorNotation: assembleErrorNotation(state.trajectory, fielderChain, errorPositions),
          starPitchUsed: state.pitchEvent?.pitch?.is_star_pitch,
          starHitResult: usedStarHit ? 'Error' : null,
          isNicePlay,
          ...errorFields,
        },
      }
      const committed = await commitPendingPA(pending)
      if (committed) {
        setInPlayState(null)
      } else {
        // commitPendingPA rejects (runner conflict / missing or too many outs)
        // via a toast + early return, without ever reaching saveEnhancedPA — so
        // nothing else unlocks the pitch actions or the 'submitting' stage this
        // function set above. Left as-is, the details/confirm panel never comes
        // back (nothing renders for 'submitting') and every other pitch button
        // stays disabled until a full page refresh. Send the scorer back to the
        // details screen so they can fix the assignment and retry.
        setInPlayState((current) => (current ? { ...current, stage: 'details' } : current))
      }
      return
    }

    // Covers every remaining in-play result (GO/FO/LO/SF/SH), including any
    // caught-ball result with the Buddy Jump modifier turned on. Because Buddy
    // Jump is metadata instead of its own result, an SF stays an SF when the
    // runner from third scores. Bases-empty plays still have only the batter
    // marked out, and an out can also carry an error charge via the same
    // ERROR-toggle fields as the hit/ROE branches above.
    const pending = {
      result: state.result,
      assignments: planAssignments,
      outResolution: true,
      originalResult: state.result,
      pitchRows: state.pitchRows,
      rollbackSnapshot: state.rollbackSnapshot || null,
      paMeta: {
        trajectory: state.trajectory,
        hitLocation: primaryPosition,
        hitNotation: errorPositions.length ? assembleErrorNotation(state.trajectory, fielderChain, errorPositions) : notation,
        direction,
        landingSpot: effectiveLandingSpot,
        hitDistanceFt,
        hitAngleDeg,
        starPitchUsed: state.pitchEvent?.pitch?.is_star_pitch,
        starHitResult: usedStarHit ? 'Out' : null,
        isNicePlay,
        ...errorFields,
        ...buddyJumpFields,
      },
    }
    const committed = await commitPendingPA(pending)
    if (committed) {
      setInPlayState(null)
    } else {
      // See the NEEDS_RESOLUTION/error branches above — commitPendingPA can
      // reject this (e.g. an out-count mismatch on a multi-runner assignment)
      // without ever unlocking pitch actions or leaving the 'submitting' stage
      // this function set earlier, which would otherwise freeze the scorebook.
      setInPlayState((current) => (current ? { ...current, stage: 'details' } : current))
    }
  }, [canEditScorebook, buildBatterRunner, runners, runnerPlan, saveEnhancedPA, pushRunners, activeDefensiveFielders, buildRunEvent, starHitPending, starHitUsed, commitPendingPA, currentBatterHandedness, stadiumKey])

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
    landingSpot = null,
    hitDistanceFt = null,
    hitAngleDeg = null,
    starHitResult = null,
    starHitRbi = 0,
    starPitchUsed = false,
    isError = false,
    errorPosition = null,
    errorCharacter = null,
    errorPlayer = null,
    errorNotation = null,
    isEarnedRun = true,
    isNicePlay = false,
    strikeoutType = null,
    isOfficialAb = true,
    fielderChoiceOut = false,
    isBuddyJump = false,
    buddyJumpAssistPosition = null,
    buddyJumpPutoutPosition = null,
    isRobbedHr = false,
    pitchRows = [],
    runEvents = [],
    nextRunners = runners,
    outsOnPlay = null,
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
    // Realtime callbacks fire as soon as the insert lands, before the explicit
    // post-save refetch below has necessarily observed every new row. Keep a
    // lagging callback from replacing the complete local game log with a shorter
    // snapshot while this save is in flight.
    deferRealtimeHydration(120000)
    if (saveWatchdogRef.current) clearTimeout(saveWatchdogRef.current)
    // Diagnostic timing: the save chain is a long sequence of Supabase round
    // trips, and we've seen it occasionally blow past the watchdog with no
    // reproducible trigger. Rather than guess again, log how long each step
    // actually took so the *next* occurrence tells us exactly which step
    // stalled instead of leaving us speculating blind.
    let saveStepLabel = 'begin'
    const saveStartedAt = performance.now()
    let saveStepStartedAt = saveStartedAt
    const saveStepLog = []
    const markSaveStep = (nextLabel) => {
      const now = performance.now()
      saveStepLog.push(`${saveStepLabel}: ${Math.round(now - saveStepStartedAt)}ms`)
      saveStepLabel = nextLabel
      saveStepStartedAt = now
    }
    saveWatchdogRef.current = setTimeout(() => {
      if (!isSavingRef.current) return
      console.warn(
        `[savePA] slow-save watchdog — still on step "${saveStepLabel}" (running ${Math.round(performance.now() - saveStepStartedAt)}ms). Completed steps:`,
        saveStepLog,
      )
      pushToast({
        title: 'Scorebook is still saving',
        message: `The save is taking longer than usual (current step: ${saveStepLabel}). Controls will stay locked until it finishes so the play cannot be recorded twice.`,
        type: 'info',
      })
    }, 15000)

    try {
    const normalizedRunScored = normalizeSavedPaRunScored(result, runScored, runEvents, currentBatter)
    const normalizedOfficialAb = isOfficialAtBat({ result })
    const existingPitchRows = editingPa
      ? gamePitches
        .filter((pitch) => String(pitch.pa_id) === String(editingPa.id))
        .map(stripDbManagedFields)
      : []
    const existingRunRows = editingPa
      ? gameRuns
        .filter((run) => String(run.pa_id) === String(editingPa.id))
        .map(stripDbManagedFields)
      : []
    const paPayload = {
      game_id: selectedGame.id,
      player_id: currentBatter.player_id,
      character_id: currentBatter.character_id,
      batting_team_id: editingPa?.batting_team_id ?? (gameSession.teamIdByPlayerId?.[currentBatter.player_id] ?? null),
      defensive_team_id: editingPa?.defensive_team_id ?? (gameSession.teamIdByPlayerId?.[offense.pitchingPlayerId] ?? null),
      pitcher_id: editingPa?.pitcher_id ?? currentPitcherStint.character_id,
      pitcher_player_id: editingPa?.pitcher_player_id ?? currentPitcherStint.player_id,
      runner_on_first_before: editingPa?.runner_on_first_before ?? Boolean(runners.first),
      runner_on_second_before: editingPa?.runner_on_second_before ?? Boolean(runners.second),
      runner_on_third_before: editingPa?.runner_on_third_before ?? Boolean(runners.third),
      inning: editingPa?.inning ?? offense.inning,
      pa_number: editingPa?.pa_number ?? (gamePAs.length + 1),
      result,
      outs_on_play: outsOnPlay,
      rbi: normalizeRbiForPaResult(result, rbi, isError),
      run_scored: normalizedRunScored,
      trajectory,
      hit_location: hitLocation,
      hit_notation: hitNotation,
      direction,
      hit_x: landingSpot?.x ?? null,
      hit_y: landingSpot?.y ?? null,
      hit_distance_ft: hitDistanceFt,
      hit_angle_deg: hitAngleDeg,
      hit_stadium_key: landingSpot ? stadiumKey : null,
      // Re-scoring an existing PA can change its distance (new location tap);
      // if it already had a hang time on file, its exit velocity/launch angle
      // were derived from the *old* distance and need to be recomputed here too
      // — otherwise they're left stale, same class of bug handleSavePlayLocation
      // guards against for the location-viewer's own edit path.
      ...(editingPa?.hang_time_sec != null ? (() => {
        const config = landingSpot && stadiumKey ? STADIUM_CONFIGS[stadiumKey] : null
        const distanceFt = exitVelocityDistanceFt({
          isRobbedHr: editingPa.is_robbed_hr,
          hitDistanceFt,
          hitAngleDeg,
        }, config)
        const recomputed = distanceFt != null ? estimateExitVelocity(distanceFt, Number(editingPa.hang_time_sec)) : null
        return { exit_velocity_mph: recomputed?.exitVelocityMph ?? null, launch_angle_deg: recomputed?.launchAngleDeg ?? null }
      })() : {}),
      star_hit_used: Boolean(starHitPending || starHitUsed),
      // starHitConnected only gets flipped true by the pitch-by-pitch FOUL/IN-PLAY handlers —
      // outcome-button shortcuts (e.g. clicking HR directly) and pendingPA resolution bypass those,
      // so they'd otherwise save a hit/contact-out with star_hit_connected still false. A batted-ball
      // result (any hit, or a contact out) is proof of contact on its own regardless of which path
      // recorded it, so let that override the flag rather than trust it as the sole source of truth.
      star_hit_connected: Boolean(starHitConnected) || ((starHitPending || starHitUsed) && battedBallResults.has(result)),
      star_hit_result: starHitResult,
      star_hit_rbi: Number(starHitRbi || 0),
      star_pitch_used: Boolean(starPitchUsed),
      star_pitch_successful: Boolean(starPitchUsed && calculateOutsForPa(result, outsOnPlay) > 0),
      is_error: Boolean(isError),
      error_position: errorPosition,
      error_character: errorCharacter,
      error_player: errorPlayer,
      error_notation: errorNotation,
      is_earned_run: Boolean(isEarnedRun),
      is_nice_play: Boolean(isNicePlay),
      strikeout_type: strikeoutType,
      is_official_ab: normalizedOfficialAb,
      fielder_choice_out: Boolean(fielderChoiceOut),
      is_buddy_jump: Boolean(isBuddyJump),
      buddy_jump_assist_position: buddyJumpAssistPosition,
      buddy_jump_putout_position: buddyJumpPutoutPosition,
      is_robbed_hr: Boolean(isRobbedHr),
    }

    const query = editingPa
      ? supabase.from(scorebookTables.plateAppearances).update(addSourceFields(paPayload)).eq('id', editingPa.id).select().single()
      : supabase.from(scorebookTables.plateAppearances).insert(addSourceFields(paPayload)).select().single()
    markSaveStep('insert-pa')
    const { data: savedPa, error } = await query
    if (error) {
      if (
        error.message?.includes('trajectory')
        || error.message?.includes('hit_location')
        || error.message?.includes('star_hit_used')
        || error.message?.includes('pitcher_id')
        || error.message?.includes('is_official_ab')
        || error.message?.includes('hit_distance_ft')
        || error.message?.includes('hit_angle_deg')
        || error.message?.includes('hit_stadium_key')
        || error.message?.includes('hit_x')
        || error.message?.includes('hit_y')
        || error.message?.includes('runner_on_first_before')
        || error.message?.includes('runner_on_second_before')
        || error.message?.includes('runner_on_third_before')
        || error.message?.includes('is_buddy_jump')
        || error.message?.includes('buddy_jump_assist_position')
        || error.message?.includes('buddy_jump_putout_position')
        || error.message?.includes('is_robbed_hr')
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

    const pitchPayload = pitchRows.map((pitch, index) => ({
      game_id: selectedGame.id,
      pa_id: savedPa.id,
      pitcher_id: pitch.pitcherId || currentPitcherChar?.name || '',
      pitcher_player: pitch.pitcherPlayer || playersById[pitch.pitcherPlayerId || currentPitcherStint.player_id]?.name || '',
      batter_id: charactersById[currentBatter.character_id]?.name || '',
      inning: editingPa?.inning ?? offense.inning,
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
    const runPayload = runEvents.map((run) => ({
      game_id: selectedGame.id,
      pa_id: savedPa.id,
      inning: editingPa?.inning ?? offense.inning,
      half: offense.isTop ? 'top' : 'bottom',
      scoring_player_id: run.playerId,
      scoring_character_id: run.characterId,
      charged_to_pitcher_id: run.chargedToPitcherId ?? currentPitcherStint.character_id,
      charged_to_pitcher_player_id: run.chargedToPitcherPlayerId ?? currentPitcherStint.player_id,
      is_earned_run: run.isEarnedRun !== false,
    }))
    const restoreSavedPaState = async () => {
      if (editingPa) {
        await Promise.all([
          supabase.from(scorebookTables.pitches).delete().eq('pa_id', savedPa.id),
          supabase.from(scorebookTables.runsScored).delete().eq('pa_id', savedPa.id),
        ])
        if (existingPitchRows.length) {
          const { error: restorePitchError } = await supabase.from(scorebookTables.pitches).insert(existingPitchRows.map(addSourceFields))
          if (restorePitchError) throw restorePitchError
        }
        if (existingRunRows.length) {
          const { error: restoreRunError } = await supabase.from(scorebookTables.runsScored).insert(existingRunRows.map(addSourceFields))
          if (restoreRunError) throw restoreRunError
        }
        const { error: restorePaError } = await supabase
          .from(scorebookTables.plateAppearances)
          .update(addSourceFields(stripDbManagedFields(editingPa)))
          .eq('id', editingPa.id)
        if (restorePaError) throw restorePaError
        return
      }

      await Promise.all([
        supabase.from(scorebookTables.pitches).delete().eq('pa_id', savedPa.id),
        supabase.from(scorebookTables.runsScored).delete().eq('pa_id', savedPa.id),
        supabase.from(scorebookTables.plateAppearances).delete().eq('id', savedPa.id),
      ])
    }

    if (editingPa) {
      markSaveStep('delete-pitch-run')
      const [{ error: deletePitchError }, { error: deleteRunError }] = await Promise.all([
        supabase.from(scorebookTables.pitches).delete().eq('pa_id', savedPa.id),
        supabase.from(scorebookTables.runsScored).delete().eq('pa_id', savedPa.id),
      ])
      if (deletePitchError || deleteRunError) {
        try {
          await restoreSavedPaState()
        } catch (restoreError) {
          pushToast({ title: 'Scorebook restore failed', message: restoreError.message, type: 'error' })
        }
        pushToast({
          title: 'Edit sync failed',
          message: deletePitchError?.message || deleteRunError?.message || 'Could not replace the saved pitch/run rows for this PA.',
          type: 'error',
        })
        return { halfCompleted: false, end: null }
      }
    }

    if (pitchPayload.length) {
      markSaveStep('insert-pitches')
      const { error: pitchInsertError } = await supabase.from(scorebookTables.pitches).insert(pitchPayload.map(addSourceFields))
      if (pitchInsertError) {
        try {
          await restoreSavedPaState()
        } catch (restoreError) {
          pushToast({ title: 'Scorebook restore failed', message: restoreError.message, type: 'error' })
        }
        pushToast({
          title: 'Pitch save failed',
          message: pitchInsertError.message,
          type: 'error',
        })
        return { halfCompleted: false, end: null }
      }
    }

    if (runPayload.length) {
      markSaveStep('insert-runs')
      const { error: runsInsertError } = await supabase.from(scorebookTables.runsScored).insert(runPayload.map(addSourceFields))
      if (runsInsertError) {
        try {
          await restoreSavedPaState()
        } catch (restoreError) {
          pushToast({ title: 'Scorebook restore failed', message: restoreError.message, type: 'error' })
        }
        pushToast({
          title: 'Run save failed',
          message: runsInsertError.message,
          type: 'error',
        })
        return { halfCompleted: false, end: null }
      }
    }

    markSaveStep('fetch-fresh-rows')
    const [paRefresh, pitchRefresh, runRefresh] = await Promise.all([
      supabase.from(scorebookTables.plateAppearances).select('*').eq('game_id', selectedGame.id).order('created_at'),
      supabase.from(scorebookTables.pitches).select('*').eq('game_id', selectedGame.id).order('created_at'),
      supabase.from(scorebookTables.runsScored).select('*').eq('game_id', selectedGame.id).order('created_at'),
    ])

    // The PA/pitch inserts above are already committed. If this follow-up read
    // fails (or briefly returns a lagging, shorter snapshot), treating `null` as
    // `[]` erases the local game history and resets the next pitch to 1. Build a
    // complete optimistic snapshot from the rows we just committed and only
    // replace it when the refresh proves it contains at least that much data.
    const normalizedSavedPa = normalizePa(savedPa)
    const optimisticPAs = editingPa
      ? gamePAs.map((pa) => (String(pa.id) === String(savedPa.id) ? normalizedSavedPa : pa))
      : [...gamePAs, normalizedSavedPa]
    const optimisticPitches = [
      ...gamePitches.filter((pitch) => String(pitch.pa_id) !== String(savedPa.id)),
      ...pitchPayload.map(addSourceFields),
    ]
    const optimisticRuns = [
      ...gameRuns.filter((run) => String(run.pa_id) !== String(savedPa.id)),
      ...runPayload.map(addSourceFields),
    ]

    const refreshedPAs = (paRefresh.data || []).map(normalizePa)
    const refreshedPitches = pitchRefresh.data || []
    const refreshedRuns = runRefresh.data || []
    const paRefreshComplete = !paRefresh.error
      && refreshedPAs.length >= optimisticPAs.length
      && refreshedPAs.some((pa) => String(pa.id) === String(savedPa.id))
    const pitchRefreshComplete = !pitchRefresh.error
      && refreshedPitches.length >= optimisticPitches.length
      && (
        pitchPayload.length === 0
        || refreshedPitches.filter((pitch) => String(pitch.pa_id) === String(savedPa.id)).length >= pitchPayload.length
      )
    const runRefreshComplete = !runRefresh.error
      && refreshedRuns.length >= optimisticRuns.length
      && (
        runPayload.length === 0
        || refreshedRuns.filter((run) => String(run.pa_id) === String(savedPa.id)).length >= runPayload.length
      )

    const allPAs = paRefreshComplete
      ? refreshedPAs.map((pa) => (String(pa.id) === String(savedPa.id) ? normalizedSavedPa : pa))
      : optimisticPAs
    const allPitches = pitchRefreshComplete ? refreshedPitches : optimisticPitches
    const allRuns = runRefreshComplete ? refreshedRuns : optimisticRuns
    const refreshProblems = [
      !paRefreshComplete && `plate appearances${paRefresh.error ? ` (${paRefresh.error.message})` : ' (incomplete snapshot)'}`,
      !pitchRefreshComplete && `pitches${pitchRefresh.error ? ` (${pitchRefresh.error.message})` : ' (incomplete snapshot)'}`,
      !runRefreshComplete && `runs${runRefresh.error ? ` (${runRefresh.error.message})` : ' (incomplete snapshot)'}`,
    ].filter(Boolean)
    if (refreshProblems.length) {
      console.warn('[savePA] post-save refresh was incomplete; retained committed local rows:', refreshProblems)
      pushToast({
        title: 'Play saved; refresh delayed',
        message: `The play was recorded, but ${refreshProblems.join(', ')} did not refresh cleanly. The complete local scorebook was preserved.`,
        type: 'info',
      })
    }

    deferRealtimeHydration()
    setPlateAppearances(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...allPAs])
    setPitches(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...allPitches])
    setRunsScored(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...allRuns])
    markSaveStep('sync-scores')
    await syncScores(allPAs, selectedGame, allRuns)
    markSaveStep('sync-inning-scores')
    await syncInningScores({ freshPAs: allPAs, freshRuns: allRuns, game: selectedGame })
    markSaveStep('recompute-pitching-stats')
    await recomputePitchingStatsForGame(allPAs, gamePitching, allRuns, allPitches)

    if (!editingPa) {
      try {
        markSaveStep('resolve-bets')
        await resolveOnPA(selectedGame.id, { ...paPayload, id: savedPa.id }, betResolutionConfig)
        markSaveStep('ensure-live-odds')
        const currentOdds = await ensureLiveOdds(gamePitching, allPAs)
        const recalcOuts = allPAs.reduce((s, pa) => s + calculateOutsForPa(pa.result, pa.outs_on_play), 0)
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
          allPAs: trackedPlateAppearances,
          allPitching: pitchingStints,
          stadiumsById,
          stadiumGameLog,
          playersById,
          currentInning: recalcOffense.inning,
          scores: { a: recalcAwayScore, b: recalcHomeScore },
          totalInnings: regulationInnings,
          bets: gameBets,
          oddsWeights: oddsEngineWeights,
        })
        const changedRows = recalculateOdds(currentOdds || [], {
          battingSide: isTeamABatting ? 'away' : 'home',
          isTop: isTeamABatting,
          paCount: allPAs.length,
          runsThisHalf: runsThisHalfFromPAs(allPAs, currentBatter.player_id, offense.inning, allRuns),
          generationContext: { ...freshOddsContext, weights: oddsEngineWeights || DEFAULT_ODDS_WEIGHTS },
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
        markSaveStep('upsert-odds')
        await upsertChangedOdds(changedRows)
      } catch (bettingError) {
        pushToast({ title: 'Betting update failed', message: bettingError.message, type: 'error' })
      }
    }
    markSaveStep('done')
    const saveTotalMs = Math.round(performance.now() - saveStartedAt)
    // Only surface the breakdown for saves that were actually slow enough to
    // matter — logging every routine save would bury the signal we're after.
    if (saveTotalMs > 3000) {
      console.warn(`[savePA] slow save: ${saveTotalMs}ms total. Step breakdown:`, saveStepLog)
    }

    const nextScores = {
      a: runsFromPAs(allPAs, selectedGame.team_a_player_id, allRuns),
      b: runsFromPAs(allPAs, selectedGame.team_b_player_id, allRuns),
    }
    const newOuts = allPAs.reduce((sum, pa) => sum + calculateOutsForPa(pa.result, pa.outs_on_play), 0)
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
    paPitchRowsRef.current = []
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
      deferRealtimeHydration()
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
  const currentBatterLink = useMemo(
    () => (currentBatter ? getCharacterLinkTarget(currentBatter.character_id) : null),
    [currentBatter, getCharacterLinkTarget],
  )
  const currentPitcherLink = useMemo(
    () => (currentPitcherChar ? getCharacterLinkTarget(currentPitcherStint.character_id) : null),
    [currentPitcherChar, currentPitcherStint, getCharacterLinkTarget],
  )

  const beginPersistentUndo = useCallback(() => {
    if (isSavingRef.current) return false
    undoInFlightRef.current = true
    isSavingRef.current = true
    setIsUndoInFlight(true)
    setIsSaving(true)
    return true
  }, [])

  const releasePersistentUndo = useCallback(({ discardQueuedCorrection = false } = {}) => {
    undoInFlightRef.current = false
    isSavingRef.current = false
    setIsUndoInFlight(false)
    setIsSaving(false)
    if (discardQueuedCorrection) {
      queuedUndoCorrectionRef.current = null
      setQueuedUndoCorrection(null)
    }
  }, [])

  const undoLastPA = useCallback(async () => {
    if (isGameComplete || !gamePAs.length || !selectedGame) return
    // Keep one persistent undo in flight at a time. The UI rolls back
    // optimistically below, while the database deletes finish in the background.
    if (!beginPersistentUndo()) return
    let interactionReleased = false
    deferRealtimeHydration(30000)
    const last = [...gamePAs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
    const lastPitches = gamePitches
      .filter((pitch) => String(pitch.pa_id) === String(last.id))
      .sort(comparePitchOrder)
    const restoredPitchNumber = lastPitches.length
      ? Math.max(0, Number(lastPitches[0].pitch_number_game || pitchNumber) - 1)
      : pitchNumber
    const redoSnapshot = {
      type: 'pa',
      gameId: String(selectedGame.id),
      pa: stripDbManagedFields(last),
      pitches: lastPitches.map(stripDbManagedFields),
      runs: gameRuns
        .filter((run) => String(run.pa_id) === String(last.id))
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        .map(stripDbManagedFields),
      runnersAfter: { ...runners },
    }
    locallyDeletedPaIdsRef.current.add(String(last.id))
    const optimisticPAs = gamePAs.filter((pa) => String(pa.id) !== String(last.id))
    const optimisticPitches = gamePitches.filter((pitch) => String(pitch.pa_id) !== String(last.id))
    const optimisticRuns = gameRuns.filter((run) => String(run.pa_id) !== String(last.id))
    const runnersHistoryBeforeUndo = runnersHistory.map((entry) => ({ ...entry }))
    const previousRedoAction = redoAction
    localActivePaRestoreRef.current = {
      gameId: selectedGame.id,
      paNumber: Number(last.pa_number || gamePAs.length),
      batterPlayerId: last.player_id,
      batterCharacterId: last.character_id,
      balls: 0,
      strikes: 0,
      pitchNumber: restoredPitchNumber,
      paPitchRows: [],
    }
    setRedoAction(redoSnapshot)
    setPlateAppearances(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...optimisticPAs])
    setPitches(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...optimisticPitches])
    setRunsScored(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...optimisticRuns])
    setShowOutsBanner(false)
    setGameEndBanner(null)
    setPendingPA(null)
    paPitchRowsRef.current = []
    setPaPitchRows([])
    restorePitchState({ balls: 0, strikes: 0, pitchNumber: restoredPitchNumber })
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

    try {
      await Promise.all([
        supabase.from(scorebookTables.pitches).delete().eq('pa_id', last.id),
        supabase.from(scorebookTables.runsScored).delete().eq('pa_id', last.id),
      ])
      const { error } = await supabase.from(scorebookTables.plateAppearances).delete().eq('id', last.id)
      if (error) throw error

      releasePersistentUndo()
      interactionReleased = true

      // Let React paint the restored batter/count and dispatch a correction tap
      // before derived score/stat maintenance starts. If that correction already
      // began saving a replacement PA, its save path owns the fresh recompute.
      await new Promise((resolve) => setTimeout(resolve, 0))
      try {
        if (!isSavingRef.current) {
          await syncScores(optimisticPAs, selectedGame, optimisticRuns)
          await syncInningScores({ freshPAs: optimisticPAs, freshRuns: optimisticRuns, game: selectedGame })
          await recomputePitchingStatsForGame(optimisticPAs, gamePitching, optimisticRuns, optimisticPitches)
        }
      } catch (maintenanceError) {
        // The PA deletion already committed. Do not visually resurrect it just
        // because a derived scoreboard/stat refresh failed afterward.
        console.warn('[scorebook undo] derived-state refresh failed after committed undo', maintenanceError)
        pushToast({
          title: 'Undo saved',
          message: `The play was removed, but its derived stats need a refresh: ${maintenanceError.message}`,
          type: 'error',
        })
      }
    } catch (error) {
      locallyDeletedPaIdsRef.current.delete(String(last.id))
      localActivePaRestoreRef.current = null
      setPlateAppearances(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...gamePAs])
      setPitches(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...gamePitches])
      setRunsScored(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...gameRuns])
      setRunners(runners)
      setRunnersHistory(runnersHistoryBeforeUndo)
      setRedoAction(previousRedoAction)
      paPitchRowsRef.current = []
      setPaPitchRows([])
      restorePitchState({ balls: 0, strikes: 0, pitchNumber })
      pushToast({ title: 'Undo failed', message: error.message, type: 'error' })
    } finally {
      if (!interactionReleased) releasePersistentUndo({ discardQueuedCorrection: true })
    }
  }, [isGameComplete, gamePAs, selectedGame, gamePitches, gameRuns, runners, runnersHistory, redoAction, pitchNumber, pushToast, popRunners, recomputePitchingStatsForGame, gamePitching, deferRealtimeHydration, restorePitchState, beginPersistentUndo, releasePersistentUndo])

  // Undo should always feel like "take back one pitch" — including the pitch
  // that just completed the previous at-bat. undoLastPA (above) throws away
  // the *entire* just-finished PA and hands the batter a fresh 0-0 count,
  // which is right when there's nothing to reopen (e.g. an admin-entered
  // result with no pitch log) but wrong the moment that PA actually had a
  // pitch sequence (e.g. a 2-strike count that ended on the 3rd pitch) —
  // the previous batter should come back up mid-count, one pitch lighter,
  // not with the whole at-bat erased.
  const dbPitchRowToLocalEntry = (row) => ({
    pitchNumberGame: Number(row.pitch_number_game || 0),
    pitchNumberPa: Number(row.pitch_number_pa || 0),
    pitcherId: row.pitcher_id || '',
    pitcherPlayer: row.pitcher_player || '',
    pitch: {
      result: row.result,
      count_balls_before: Number(row.count_balls_before || 0),
      count_strikes_before: Number(row.count_strikes_before || 0),
      count_balls_after: Number(row.count_balls_after || 0),
      count_strikes_after: Number(row.count_strikes_after || 0),
      is_star_pitch: Boolean(row.is_star_pitch),
    },
  })

  const reopenLastCompletedPA = useCallback(async (lastPitches) => {
    if (isGameComplete || !gamePAs.length || !selectedGame) return
    // See undoLastPA: keep the database cleanup single-flight even though the
    // batter/count are restored optimistically.
    if (!beginPersistentUndo()) return
    let interactionReleased = false
    // Deleting this PA's pitches below changes currentPitcherPitchRows.length, which
    // re-runs the sessionStorage-hydration effect before the live_state publish effect
    // has caught up to the restored count — hold that effect off live-state hydration
    // for a bit so it trusts the snapshot we write below instead of stale DB state.
    deferRealtimeHydration(30000)
    const last = [...gamePAs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
    const redoSnapshot = {
      type: 'pa',
      gameId: String(selectedGame.id),
      pa: stripDbManagedFields(last),
      pitches: lastPitches.map(stripDbManagedFields),
      runs: gameRuns
        .filter((run) => String(run.pa_id) === String(last.id))
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        .map(stripDbManagedFields),
      runnersAfter: { ...runners },
    }

    const remainingRows = lastPitches.slice(0, -1).map(dbPitchRowToLocalEntry)
    const removedRow = dbPitchRowToLocalEntry(lastPitches[lastPitches.length - 1])
    const restoredBalls = removedRow.pitch.count_balls_before
    const restoredStrikes = removedRow.pitch.count_strikes_before
    const restoredPitchNumber = Math.max(0, removedRow.pitchNumberGame - 1)

    locallyDeletedPaIdsRef.current.add(String(last.id))
    const optimisticPAs = gamePAs.filter((pa) => String(pa.id) !== String(last.id))
    const optimisticPitches = gamePitches.filter((pitch) => String(pitch.pa_id) !== String(last.id))
    const optimisticRuns = gameRuns.filter((run) => String(run.pa_id) !== String(last.id))
    const runnersHistoryBeforeUndo = runnersHistory.map((entry) => ({ ...entry }))
    const previousRedoAction = redoAction
    // `currentActivePaScope` still describes the on-deck batter at this point.
    // Store an identity-based restore instead; the hydration effect applies it
    // after removing the completed PA makes this batter current again.
    localActivePaRestoreRef.current = {
      gameId: selectedGame.id,
      paNumber: Number(last.pa_number || gamePAs.length),
      batterPlayerId: last.player_id,
      batterCharacterId: last.character_id,
      balls: restoredBalls,
      strikes: restoredStrikes,
      pitchNumber: restoredPitchNumber,
      paPitchRows: remainingRows,
    }
    setRedoAction(redoSnapshot)
    setPlateAppearances(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...optimisticPAs])
    setPitches(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...optimisticPitches])
    setRunsScored(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...optimisticRuns])
    setShowOutsBanner(false)
    setGameEndBanner(null)
    setPendingPA(null)
    setPitchActionSheet(null)
    setPendingPitchEvent(null)
    setInPlayState(null)
    setRbiOverlay(null)
    setStarPitchActive(false)
    setStarHitUsed(false)
    setStarHitPending(false)
    setStarHitConnected(false)
    popRunners()
    paPitchRowsRef.current = remainingRows
    setPaPitchRows(remainingRows)
    restorePitchState({ balls: restoredBalls, strikes: restoredStrikes, pitchNumber: restoredPitchNumber })
    try { sessionStorage.removeItem(getActivePaStorageKey(selectedGame.id)) } catch {}
    if (navigator.vibrate) navigator.vibrate(30)

    try {
      await Promise.all([
        supabase.from(scorebookTables.pitches).delete().eq('pa_id', last.id),
        supabase.from(scorebookTables.runsScored).delete().eq('pa_id', last.id),
      ])
      const { error } = await supabase.from(scorebookTables.plateAppearances).delete().eq('id', last.id)
      if (error) throw error

      releasePersistentUndo()
      interactionReleased = true

      await new Promise((resolve) => setTimeout(resolve, 0))
      try {
        if (!isSavingRef.current) {
          await syncScores(optimisticPAs, selectedGame, optimisticRuns)
          await syncInningScores({ freshPAs: optimisticPAs, freshRuns: optimisticRuns, game: selectedGame })
          await recomputePitchingStatsForGame(optimisticPAs, gamePitching, optimisticRuns, optimisticPitches)
        }
      } catch (maintenanceError) {
        console.warn('[scorebook undo] derived-state refresh failed after committed reopen', maintenanceError)
        pushToast({
          title: 'Undo saved',
          message: `The pitch was removed, but its derived stats need a refresh: ${maintenanceError.message}`,
          type: 'error',
        })
      }
    } catch (error) {
      locallyDeletedPaIdsRef.current.delete(String(last.id))
      localActivePaRestoreRef.current = null
      setPlateAppearances(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...gamePAs])
      setPitches(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...gamePitches])
      setRunsScored(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...gameRuns])
      setRunners(runners)
      setRunnersHistory(runnersHistoryBeforeUndo)
      setRedoAction(previousRedoAction)
      paPitchRowsRef.current = []
      setPaPitchRows([])
      restorePitchState({ balls: 0, strikes: 0, pitchNumber })
      pushToast({ title: 'Undo failed', message: error.message, type: 'error' })
    } finally {
      if (!interactionReleased) releasePersistentUndo({ discardQueuedCorrection: true })
    }
  }, [isGameComplete, gamePAs, selectedGame, gamePitches, gameRuns, runners, runnersHistory, redoAction, pitchNumber, pushToast, popRunners, recomputePitchingStatsForGame, gamePitching, restorePitchState, deferRealtimeHydration, beginPersistentUndo, releasePersistentUndo])

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
    paPitchRowsRef.current = paPitchRowsRef.current.slice(0, -1)
    setPaPitchRows(paPitchRowsRef.current)
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
  const canUndoAction = Boolean(canEditScorebook && !isSaving && (gamePAs.length || paPitchRows.length))
  const canRedoUiAction = Boolean(canEditScorebook && !isSaving && canRedoAction)

  const handleRedoAction = useCallback(async () => {
    if (isGameComplete || isSaving || isSavingRef.current || !redoAction) return

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

    // Same reentrancy hazard as undoLastPA/reopenLastCompletedPA below — several
    // sequential Supabase round trips before gamePAs reflects the restore.
    if (isSavingRef.current) return
    isSavingRef.current = true
    setIsSaving(true)
    try {
    deferRealtimeHydration(30000)
    // Sanitize again at execution time so a Redo snapshot captured before a
    // client update cannot retain display-only fields in component state.
    const restoredPaPayload = stripDbManagedFields(redoAction.pa)
    const { data: restoredPa, error } = await supabase
      .from(scorebookTables.plateAppearances)
      .insert(restoredPaPayload)
      .select()
      .single()
    if (error) {
      pushToast({ title: 'Redo failed', message: error.message, type: 'error' })
      return
    }

    const restoredPitchRows = (redoAction.pitches || []).map((pitch) => ({ ...pitch, pa_id: restoredPa.id }))
    const restoredRunRows = (redoAction.runs || []).map((run) => ({ ...run, pa_id: restoredPa.id }))
    const rollbackRestoredPa = async () => {
      await Promise.all([
        supabase.from(scorebookTables.pitches).delete().eq('pa_id', restoredPa.id),
        supabase.from(scorebookTables.runsScored).delete().eq('pa_id', restoredPa.id),
      ])
      await supabase.from(scorebookTables.plateAppearances).delete().eq('id', restoredPa.id)
    }

    if (redoAction.pitches?.length) {
      const { error: pitchInsertError } = await supabase
        .from(scorebookTables.pitches)
        .insert(restoredPitchRows)
      if (pitchInsertError) {
        await rollbackRestoredPa()
        pushToast({ title: 'Pitch restore failed', message: pitchInsertError.message, type: 'error' })
        return
      }
    }

    if (redoAction.runs?.length) {
      const { error: runsInsertError } = await supabase
        .from(scorebookTables.runsScored)
        .insert(restoredRunRows)
      if (runsInsertError) {
        await rollbackRestoredPa()
        pushToast({ title: 'Run restore failed', message: runsInsertError.message, type: 'error' })
        return
      }
    }

    const [paRefresh, pitchRefresh, runRefresh] = await Promise.all([
      supabase.from(scorebookTables.plateAppearances).select('*').eq('game_id', selectedGame.id).order('created_at'),
      supabase.from(scorebookTables.pitches).select('*').eq('game_id', selectedGame.id).order('created_at'),
      supabase.from(scorebookTables.runsScored).select('*').eq('game_id', selectedGame.id).order('created_at'),
    ])
    const optimisticPAs = [...gamePAs, normalizePa(restoredPa)]
    const optimisticPitches = [...gamePitches, ...restoredPitchRows]
    const optimisticRuns = [...gameRuns, ...restoredRunRows]
    const paRefreshComplete = !paRefresh.error
      && (paRefresh.data || []).length >= optimisticPAs.length
      && (paRefresh.data || []).some((pa) => String(pa.id) === String(restoredPa.id))
    const pitchRefreshComplete = !pitchRefresh.error
      && (pitchRefresh.data || []).length >= optimisticPitches.length
      && (
        restoredPitchRows.length === 0
        || (pitchRefresh.data || []).filter((pitch) => String(pitch.pa_id) === String(restoredPa.id)).length >= restoredPitchRows.length
      )
    const runRefreshComplete = !runRefresh.error
      && (runRefresh.data || []).length >= optimisticRuns.length
      && (
        restoredRunRows.length === 0
        || (runRefresh.data || []).filter((run) => String(run.pa_id) === String(restoredPa.id)).length >= restoredRunRows.length
      )
    const allPAs = paRefreshComplete ? (paRefresh.data || []).map(normalizePa) : optimisticPAs
    const allPitches = pitchRefreshComplete ? (pitchRefresh.data || []) : optimisticPitches
    const allRuns = runRefreshComplete ? (runRefresh.data || []) : optimisticRuns
    if (!paRefreshComplete || !pitchRefreshComplete || !runRefreshComplete) {
      console.warn('[redoPA] post-restore refresh was incomplete; retained the optimistic local restore')
      pushToast({
        title: 'Redo saved; refresh delayed',
        message: 'The plate appearance was restored and the complete local scorebook was preserved.',
        type: 'info',
      })
    }
    deferRealtimeHydration()
    setPlateAppearances(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...allPAs])
    setPitches(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...allPitches])
    setRunsScored(cur => [...cur.filter(p => String(p.game_id) !== String(selectedGame.id)), ...allRuns])
    await syncScores(allPAs, selectedGame, allRuns)
    await syncInningScores({ freshPAs: allPAs, freshRuns: allRuns, game: selectedGame })
    await recomputePitchingStatsForGame(allPAs, gamePitching, allRuns, allPitches)

    const newOuts = allPAs.reduce((sum, pa) => sum + calculateOutsForPa(pa.result, pa.outs_on_play), 0)
    const prevHalf = Math.floor(outsBeforeRedo / 3)
    const newHalf = Math.floor(newOuts / 3)

    setShowOutsBanner(newHalf > prevHalf)
    setGameEndBanner(null)
    setPendingPA(null)
    paPitchRowsRef.current = []
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
    } finally {
      isSavingRef.current = false
      setIsSaving(false)
    }
  }, [isGameComplete, isSaving, redoAction, currentActivePaScope, selectedGame, restoreActivePaSnapshot, clearRedoAction, pushToast, recomputePitchingStatsForGame, gamePitching, gamePAs, gamePitches, gameRuns, pushRunners, deferRealtimeHydration])

  const handleUndoAction = useCallback(() => {
    // Check the ref (not just the `isSaving` state, which lags a render behind
    // the ref during the async undo/redo functions below) so a fast double-tap
    // can't slip a second call in before React re-renders with the disabled button.
    if (!canEditScorebook || isSaving || isSavingRef.current) return
    if (paPitchRows.length) {
      undoLastPitch()
      return
    }
    if (!gamePAs.length) return
    const last = [...gamePAs].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0]
    const lastPitches = gamePitches
      .filter((pitch) => String(pitch.pa_id) === String(last.id))
      .sort(comparePitchOrder)
    // A PA with 0-1 pitches (e.g. an admin-entered result) has nothing to
    // reopen one pitch into — undo the whole plate appearance instead.
    if (lastPitches.length < 2) {
      undoLastPA()
      return
    }
    reopenLastCompletedPA(lastPitches)
  }, [canEditScorebook, isSaving, paPitchRows.length, gamePAs, gamePitches, undoLastPitch, undoLastPA, reopenLastCompletedPA])

  // Replay a correction tapped during persistent Undo against the now-restored
  // batter/count. Clearing the ref first guarantees it can only run once.
  useEffect(() => {
    if (isUndoInFlight || !queuedUndoCorrection) return
    queuedUndoCorrectionRef.current = null
    setQueuedUndoCorrection(null)
    switch (queuedUndoCorrection.type) {
      case 'ball':
        handlePitchBall()
        break
      case 'foul':
        handlePitchFoul()
        break
      case 'hbp':
        handlePitchHbp()
        break
      case 'strike':
        handleStrikeChoice(queuedUndoCorrection.strikeType)
        break
      case 'in_play':
        handlePitchInPlay()
        break
      default:
        break
    }
  }, [isUndoInFlight, queuedUndoCorrection, handlePitchBall, handlePitchFoul, handlePitchHbp, handleStrikeChoice, handlePitchInPlay])

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
      const buildFielders = (lineupRows, saved) => {
        const savedPositions = saved?.fieldingPositions && typeof saved.fieldingPositions === 'object'
          ? saved.fieldingPositions
          : {}
        const lineupByCharacterId = Object.fromEntries(lineupRows.map((row) => [row.character_id, row]))
        const seededFielding = {}

        Object.entries(savedPositions).forEach(([fieldId, characterId]) => {
          if (!lineupByCharacterId[characterId] || !FIELD_ID_TO_SCOREBOOK_POSITION[fieldId]) return
          seededFielding[fieldId] = characterId
        })

        const placedIds = new Set(Object.values(seededFielding).map((characterId) => String(characterId)))
        const remainingRows = lineupRows.filter((row) => !placedIds.has(String(row.character_id)))
        const emptyFieldIds = FIELD_POSITIONS.map((position) => position.id).filter((fieldId) => !seededFielding[fieldId])
        remainingRows.forEach((row, index) => {
          if (emptyFieldIds[index]) seededFielding[emptyFieldIds[index]] = row.character_id
        })

        return Object.entries(seededFielding).map(([fieldId, characterId]) => {
          const lineupRow = lineupByCharacterId[characterId]
          return {
            game_id: selectedGame.id,
            team_id: isSeasonGame ? gameSession.teamIdByPlayerId?.[lineupRow.player_id] || null : lineupRow.player_id,
            player_name: playersById[lineupRow.player_id]?.name || '',
            character: charactersById[characterId]?.name || '',
            position: FIELD_ID_TO_SCOREBOOK_POSITION[fieldId],
            inning_from: 1,
            inning_to: null,
          }
        })
      }

      const teamALineupRows = buildRows(teamRosters.teamA, selectedGame.team_a_player_id, savedTeamA)
      const teamBLineupRows = buildRows(teamRosters.teamB, selectedGame.team_b_player_id, savedTeamB)
      const desiredPayload = [...teamALineupRows, ...teamBLineupRows]

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
      const fielderPayload = [
        ...buildFielders(teamALineupRows, savedTeamA),
        ...buildFielders(teamBLineupRows, savedTeamB),
      ]

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
    // Assign W/L/S to the correct pitching stints — reuses the same play-by-play
    // reconstruction (derivePitchingDecisions) that Stats/CharacterPage recompute
    // from historical data, instead of the old "whoever finished the game for the
    // winning side gets the win" shortcut. That shortcut had no concept of *when*
    // the lead changed hands, so a reliever who mopped up the last inning (with
    // nothing left to decide) got credited over the pitcher who was actually on
    // the mound when the team took the lead for good — and never awarded a save
    // at all. There's no innings-pitched requirement for a win here (that's an
    // MLB starter-specific rule, not applicable to these short games); the only
    // innings-based check is the save's own "3 full innings" qualifying clause.
    try {
      const sortedStints = [...gamePitching].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      const sideForPlayerId = (pid) => (
        String(pid) === String(selectedGame.team_a_player_id) ? 'A'
          : String(pid) === String(selectedGame.team_b_player_id) ? 'B'
            : null
      )
      const winnerSide = resolved ? sideForPlayerId(resolved) : null
      // Deliberately not passing through s.win/s.loss/s.save here — derivePitchingDecisions
      // honors any already-true flag as final and skips recomputing it, which is right for
      // the season/tournament-wide recompute (don't clobber a correctly-decided game) but
      // wrong here: this *is* the authoritative moment those flags get decided for this game,
      // so it needs to always reconstruct fresh from this game's own play-by-play — including
      // when re-completing after a reopen, so a previous bad computation doesn't stick around.
      const decisionStints = sortedStints.map((s) => ({
        id: s.id,
        characterId: s.character_id,
        playerId: s.player_id,
        side: sideForPlayerId(s.player_id),
        createdAt: s.created_at,
        inningsPitched: s.innings_pitched,
        win: false,
        loss: false,
        save: false,
      }))
      const decisionPas = [...gamePAs]
        .sort((a, b) => (Number(a.pa_number || 0) - Number(b.pa_number || 0)) || new Date(a.created_at || 0) - new Date(b.created_at || 0))
        .map((pa) => ({
          id: pa.id,
          side: sideForPlayerId(pa.player_id),
          createdAt: pa.created_at,
          result: pa.result,
          rbi: pa.rbi,
          run_scored: pa.run_scored,
          pitcherCharacterId: pa.pitcher_id ?? null,
          pitcherPlayerId: pa.pitcher_player_id ?? null,
        }))
      const { winStint, lossStint, saveStint } = winnerSide
        ? derivePitchingDecisions({ pas: decisionPas, runsByPaId: groupRunsByPaId(gameRuns), stints: decisionStints, winnerSide })
        : { winStint: null, lossStint: null, saveStint: null }
      const winLossUpdates = []
      sortedStints.forEach((s) => {
        const isWin = winStint?.id === s.id
        const isLoss = lossStint?.id === s.id
        const isSave = saveStint?.id === s.id
        if (Boolean(s.win) !== isWin || Boolean(s.loss) !== isLoss || Boolean(s.save) !== isSave) {
          winLossUpdates.push(supabase.from(scorebookTables.pitchingStints).update({ win: isWin, loss: isLoss, save: isSave }).eq('id', s.id))
        }
      })
      await Promise.all(winLossUpdates)
      if (winLossUpdates.length) {
        setPitchingStints((cur) => cur.map((s) => (
          String(s.game_id) === String(selectedGame.id)
            ? { ...s, win: winStint?.id === s.id, loss: lossStint?.id === s.id, save: saveStint?.id === s.id }
            : s
        )))
      }
    } catch (wlError) {
      pushToast({ title: 'W/L assignment failed', message: wlError.message, type: 'error' })
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
  }, [selectedGame, scores, currentInning, pushToast, gamePitching, charactersById, playersById, tournament, games, isSeasonGame, gameSession, scorebookTables.games, scorebookTables.stadiumGameLog, scorebookTables.pitchingStints, selectedStadium, betResolutionConfig])

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

    // Clear W/L on all stints for this game.
    try {
      const stintIds = gamePitching.filter((s) => s.win || s.loss).map((s) => s.id)
      if (stintIds.length) {
        await supabase.from(scorebookTables.pitchingStints).update({ win: false, loss: false }).in('id', stintIds)
        setPitchingStints((cur) => cur.map((s) => stintIds.includes(s.id) ? { ...s, win: false, loss: false } : s))
      }
    } catch (wlError) {
      pushToast({ title: 'W/L reset failed', message: wlError.message, type: 'error' })
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
    // The auto-assign effect and a manual mound tap/drag can both call this
    // for the same half-inning turnover before either's insert round-trips
    // back into currentPitcherStint — without a lock both pass the guard
    // above and each inserts their own stint row for the same pitcher,
    // producing a duplicate 0-inning "ghost" line in the pitching box score.
    if (pitcherChangePendingRef.current) return
    pitcherChangePendingRef.current = true
    const previousPitcherStint = currentPitcherStint
    const newStint = {
      game_id: selectedGame.id, player_id: playerId, character_id: characterId,
      innings_pitched: 0, hits_allowed: 0, runs_allowed: 0, earned_runs: 0, walks: 0, strikeouts: 0, hr_allowed: 0, pitches_thrown: 0, strikes_thrown: 0,
    }
    let data, error
    try {
      ({ data, error } = await supabase.from(scorebookTables.pitchingStints).insert(addSourceFields(newStint)).select().single())
    } finally {
      pitcherChangePendingRef.current = false
    }
    if (error) { pushToast({ title: 'Pitcher change failed', message: error.message, type: 'error' }); return }
    // Optimistic update — don't wait for realtime to refresh the mound, and
    // hold off the next data reload from clobbering it with a lagging read
    deferRealtimeHydration()
    const nextPitcherName = charactersById[characterId]?.name || ''
    const nextPitchNumber = nextPitcherName
      ? gamePitches.filter((pitch) => pitch.pitcher_id === nextPitcherName).length
      : 0
    // Update the count in the same batch as the optimistic stint change. If the
    // stint renders first with the previous pitcher's number, the live-state
    // publisher can persist that stale number under the new stint id and then
    // hydrate it back as if it were authoritative.
    restorePitchState({ balls, strikes, pitchNumber: nextPitchNumber })
    if (data) setPitchingStints(cur => [...cur, data])

    // Keep the in-game lineup draft aligned with the new pitcher so future
    // half-innings use the live game projection rather than falling back to the
    // pregame saved team_lineups snapshot.
    const changedTeam = String(playerId) === String(selectedGame.team_a_player_id) ? 'A'
      : String(playerId) === String(selectedGame.team_b_player_id) ? 'B' : null
    if (changedTeam) {
      setLineupDrafts((current) => {
        const draftForTeam = current[changedTeam] || { order: [], fielding: {} }
        return { ...current, [changedTeam]: { ...draftForTeam, fielding: { ...draftForTeam.fielding, pitcher: characterId } } }
      })
    }
    try {
      const nextPitching = data ? [...gamePitching, data] : gamePitching
      const generationContext = buildOddsGenerationContext(nextPitching, gamePAs)
      const currentOdds = await ensureLiveOdds(nextPitching, gamePAs)
      const changedRows = recalculateOdds(currentOdds || [], {
        pitcherSwap: true,
        generationContext: generationContext ? { ...generationContext, weights: oddsEngineWeights || DEFAULT_ODDS_WEIGHTS } : null,
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
          // season_bets has no game_odds_id column — it isn't tied to a specific
          // odds row, so match on the same (game, bet_type, target_entity) key
          // used to look up the stale prop above instead.
          const relatedBetsQuery = isSeasonGame
            ? supabase.from(scorebookTables.bets).select('id').eq('game_id', selectedGame.id).eq('bet_type', 'k_prop').eq('target_entity', oldLabel).limit(1)
            : supabase.from(scorebookTables.bets).select('id').eq('game_odds_id', staleKProp.id).limit(1)
          const { data: relatedBets } = await relatedBetsQuery
          if (!relatedBets || relatedBets.length === 0) {
            await supabase.from(scorebookTables.gameOdds).delete().eq('id', staleKProp.id)
          }
        }
      }
    } catch (bettingError) {
      pushToast({ title: 'Odds refresh failed', message: bettingError.message, type: 'error' })
    }
    pushToast({ title: `Pitcher → ${charactersById[characterId]?.name}`, type: 'success' })
  }, [selectedGame, canEditScorebook, charactersById, playersById, pushToast, gamePitching, gamePitches, currentPitcherStint, buildOddsGenerationContext, gamePAs, upsertChangedOdds, ensureLiveOdds, scorebookTables.pitchingStints, scorebookTables.bets, scorebookTables.gameOdds, addSourceFields, deferRealtimeHydration, isSeasonGame, lineupDrafts, gameSession?.sourceId, restorePitchState, balls, strikes])

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
    const team = String(offense.pitchingPlayerId) === String(selectedGame.team_a_player_id) ? 'A'
      : String(offense.pitchingPlayerId) === String(selectedGame.team_b_player_id) ? 'B' : null
    const desiredPitcherCharId = team ? Number(lineupDrafts[team]?.fielding?.pitcher || 0) : 0
    const seededPitcher = defensiveLineup.find((entry) => Number(entry.character_id) === desiredPitcherCharId)
    const pitcherToUse = seededPitcher || defensiveLineup[0] || null
    if (!pitcherToUse?.character_id) {
      autoPitcherAssignRef.current = null
      return
    }
    changePitcher(offense.pitchingPlayerId, pitcherToUse.character_id).finally(() => {
      if (autoPitcherAssignRef.current === assignKey) autoPitcherAssignRef.current = null
    })
  }, [selectedGame?.id, selectedGame?.team_a_player_id, selectedGame?.team_b_player_id, isGameComplete, offense?.pitchingPlayerId, currentPitcherStint?.id, defensiveLineup, lineupDrafts, changePitcher])

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
          { key: 'exitVelo', label: 'At-Bat Data' },
          { key: 'admin', label: 'Admin' },
        ].map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => runViewChange(() => setViewMode(tab.key))}
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
      <UnsavedChangesPrompt
        blocker={viewChangeBlocker}
        onSave={handleSaveAllDirtyAndAtBat}
        onDiscard={handleDiscardAllDirtyAndAtBat}
        message={unsavedChangesMessage}
      />
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
              <StadiumHeaderPill stadium={selectedStadium} isNight={selectedGame?.is_night} onEdit={isScorekeeper ? openStadiumEditModal : undefined} />
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
                ].map((entry) => {
                  const link = entry.stint ? getCharacterLinkTarget(entry.stint.character_id) : null
                  return (
                    <MiddleClickLink
                      key={entry.label}
                      to={link?.to}
                      state={link?.state}
                      style={{ borderRadius: 14, border: `1px solid ${entry.tone}44`, background: `${entry.tone}14`, padding: 12, display: 'flex', alignItems: 'center', gap: 10, cursor: link ? 'pointer' : 'default', color: 'inherit', textDecoration: 'none' }}
                    >
                      <div style={{ width: 42, height: 42, borderRadius: '50%', overflow: 'hidden', border: `2px solid ${entry.tone}` }}>
                        <Avatar name={charactersById[entry.stint?.character_id]?.name} size={42} />
                      </div>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ color: entry.tone, fontSize: 11, fontWeight: 800, textTransform: 'uppercase' }}>{entry.label}</div>
                        <div style={{ color: '#F8FAFC', fontSize: 14, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{charactersById[entry.stint?.character_id]?.name || 'Not recorded'}</div>
                        <div style={{ color: C.muted, fontSize: 12 }}>{entry.stint ? `IP ${entry.stint.innings_pitched ?? 0} / H ${entry.stint.hits_allowed ?? 0} / R ${entry.stint.runs_allowed ?? 0}` : 'Decision unavailable'}</div>
                      </div>
                    </MiddleClickLink>
                  )
                })}
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                <div style={{ borderRadius: 14, border: `1px solid ${C.border}`, background: 'rgba(15,23,42,0.58)', padding: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: C.muted, fontSize: 11, fontWeight: 800, textTransform: 'uppercase', marginBottom: 8 }}>
                    <TeamLogo logoKey={battingIdentity?.teamLogoKey} logoUrl={battingIdentity?.teamLogoUrl || battingPlayer?.team_logo_url} teamName={battingPlayer?.name} height={14} />
                    Current Batter
                  </div>
                  <MiddleClickLink
                    to={currentBatterLink?.to}
                    state={currentBatterLink?.state}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: currentBatter ? 'pointer' : 'default', color: 'inherit', textDecoration: 'none' }}
                  >
                    <div style={{ width: 42, height: 42, borderRadius: '50%', overflow: 'hidden', border: `2px solid ${battingColor}` }}>
                      <Avatar name={charactersById[currentBatter?.character_id]?.name} size={42} />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color: '#F8FAFC', fontSize: 14, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{charactersById[currentBatter?.character_id]?.name || 'Waiting on lineup'}</div>
                      <div style={{ color: C.muted, fontSize: 12 }}>{currentBatter ? `AVG ${formatBaseballAverage(lineupStatsByEntryKey[currentEntryKey]?.source || {})} / ${formatHitsAtBats(currentBatterGameSummary)}` : 'No batter yet'}</div>
                    </div>
                  </MiddleClickLink>
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
                  <MiddleClickLink
                    to={currentPitcherLink?.to}
                    state={currentPitcherLink?.state}
                    style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: currentPitcherChar ? 'pointer' : 'default', color: 'inherit', textDecoration: 'none' }}
                  >
                    <div style={{ width: 42, height: 42, borderRadius: '50%', overflow: 'hidden', border: `2px solid ${pitchingColor}` }}>
                      <Avatar name={currentPitcherChar?.name} size={42} />
                    </div>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color: '#F8FAFC', fontSize: 14, fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{currentPitcherChar?.name || 'Waiting on pitcher'}</div>
                      <div style={{ color: C.muted, fontSize: 12 }}>IP {currentPitcherGameLine.ip ?? 0} / H {currentPitcherGameLine.h ?? 0} / R {currentPitcherGameLine.r ?? 0} / K {currentPitcherGameLine.k ?? 0}</div>
                      <div style={{ color: C.muted, fontSize: 12 }}>Pitch Count {displayPitchNumber}</div>
                    </div>
                  </MiddleClickLink>
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
              activeBattingSide={activeBattingSide}
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
              <LineupStatsTable title={`${teamAAbbreviation} Lineup`} lineup={teamALineup} statsByEntryKey={lineupStatsByEntryKey} currentEntryKey={currentEntryKey} teamColor={teamAColor} charactersById={charactersById} getCharacterLink={(characterId) => getCharacterLinkTarget(characterId)} />
            ) : (
              <LineupStatsTable title={`${teamBAbbreviation} Lineup`} lineup={teamBLineup} statsByEntryKey={lineupStatsByEntryKey} currentEntryKey={currentEntryKey} teamColor={teamBColor} charactersById={charactersById} getCharacterLink={(characterId) => getCharacterLinkTarget(characterId)} />
            )}
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
            <LineupStatsTable title={`${teamAAbbreviation} Lineup`} lineup={teamALineup} statsByEntryKey={lineupStatsByEntryKey} currentEntryKey={currentEntryKey} teamColor={teamAColor} charactersById={charactersById} getCharacterLink={(characterId) => getCharacterLinkTarget(characterId)} />
            <LineupStatsTable title={`${teamBAbbreviation} Lineup`} lineup={teamBLineup} statsByEntryKey={lineupStatsByEntryKey} currentEntryKey={currentEntryKey} teamColor={teamBColor} charactersById={charactersById} getCharacterLink={(characterId) => getCharacterLinkTarget(characterId)} />
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
          <PitchingStatsTable title={`${teamAAbbreviation} Pitchers`} stints={teamAPitching} decisionLabels={pitcherDecisionLabels} charactersById={charactersById} getCharacterLink={(characterId) => getCharacterLinkTarget(characterId)} sourceStatsByCharacterKey={pitchingSourceStatsByCharacterKey} />
          <PitchingStatsTable title={`${teamBAbbreviation} Pitchers`} stints={teamBPitching} decisionLabels={pitcherDecisionLabels} charactersById={charactersById} getCharacterLink={(characterId) => getCharacterLinkTarget(characterId)} sourceStatsByCharacterKey={pitchingSourceStatsByCharacterKey} />
        </div>
      </div>
      {stadiumEditModalOpen && (
        <EditStadiumModal
          stadiums={stadiums}
          stadiumEditForm={stadiumEditForm}
          setStadiumEditForm={setStadiumEditForm}
          onSave={saveStadiumEdit}
          onClose={() => setStadiumEditModalOpen(false)}
          saving={stadiumEditSaving}
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
        <div
          className="roster-grid"
          style={{
            gridTemplateColumns: isNarrowViewport ? '1fr' : 'minmax(0, 0.88fr) minmax(340px, 1.12fr)',
            alignItems: 'start',
            gap: 16,
          }}
        >
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
                      onOpenCard={() => openCharacterPage(charId)}
                      compact
                      portraitScale={0.88}
                      lineupNumber={index + 1}
                      positionLabel={positionByCharId[charId] || null}
                      onLineupNumberClick={() => handleLineupNumberClick(team, charId, index)}
                      lineupNumberSelected={selectedLineupMoveId[team] === charId}
                      lineupNumberAriaLabel={`Lineup spot ${index + 1}`}
                      lineupNumberTitle={selectedLineupMoveId[team] === charId ? 'Selected lineup slot' : 'Tap to swap this player with another lineup slot'}
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
            fieldScale={1.16}
            portraitScale={0.85}
          />
        </div>
        <SaveLineupBar
          isDirty={lineupDirty[team]}
          status={lineupSaveStatus[team]}
          onSave={() => handleSaveLineupTeam(team)}
          label={`Save Team ${team} Lineup`}
        />
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

  const renderExitVelocityView = () => (
    <div style={{ color: C.text, paddingBottom: 40, margin: '-1.25rem -1.25rem 0' }}>
      {scorebookToolbar}
      {viewTabs}
      <div style={{ padding: '8px 10px 32px', display: 'grid', gap: 12 }}>
        {!selectedGame ? (
          <div style={{ color: C.muted, textAlign: 'center', padding: 24 }}>Select a game to enter at-bat data.</div>
        ) : (
          <SectionCard hideHeader>
            <AtBatDataEntryPanel
              ref={atBatPanelRef}
              game={selectedGame}
              pas={gamePAs}
              pitches={gamePitches}
              charactersById={charactersById}
              stadiumKey={stadiumKey}
              atBatSource={isSeasonGame ? 'season' : 'tournament'}
              onSave={handleSaveExitVelocity}
              onSavePitchType={handleSavePitchType}
              onDirtyChange={setAtBatDataDirty}
            />
          </SectionCard>
        )}
      </div>
    </div>
  )

  const renderAdminView = () => {
    return (
      <div style={{ color: C.text, paddingBottom: 40, margin: '-1.25rem -1.25rem 0' }}>
        {scorebookToolbar}
        {viewTabs}
        <div style={{ padding: '8px 10px 32px', display: 'grid', gap: 12 }}>
          {!selectedGame ? (
            <div style={{ color: C.muted, textAlign: 'center', padding: 24 }}>Select a game to manage scorebook corrections.</div>
          ) : (
            <>
              <SectionCard title="Game Video">
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    placeholder="https://www.youtube.com/watch?v=..."
                    value={videoUrlDraft}
                    onChange={(e) => setVideoUrlDraft(e.target.value)}
                    style={{ flex: 1, minWidth: 260, padding: '8px 10px' }}
                  />
                  <button type="button" className="solid-button" onClick={saveVideoUrl} disabled={videoUrlSaving}>
                    {videoUrlSaving ? 'Saving…' : 'Save video URL'}
                  </button>
                </div>
              </SectionCard>

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
                      <button type="button" className="ghost-button" disabled={!canUndoAction} onClick={handleUndoAction}>
                        Undo Latest Action
                      </button>
                      {isGameComplete ? (
                        <button type="button" className="solid-button" onClick={() => setShowReopenGameConfirm(true)}>
                          Reopen Game
                        </button>
                      ) : null}
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
    return <>{renderLineupsView()}<UnsavedChangesPrompt blocker={lineupBlocker} onSave={handleSaveAllDirtyAndAtBat} onDiscard={handleDiscardAllDirtyAndAtBat} message={unsavedChangesMessage} /></>
  }

  if (viewMode === 'exitVelo' && isScorekeeper) {
    return <>{renderExitVelocityView()}<UnsavedChangesPrompt blocker={lineupBlocker} onSave={handleSaveAllDirtyAndAtBat} onDiscard={handleDiscardAllDirtyAndAtBat} message={unsavedChangesMessage} /></>
  }

  if (viewMode === 'admin' && isScorekeeper) {
    return <>{renderAdminView()}<UnsavedChangesPrompt blocker={lineupBlocker} onSave={handleSaveAllDirtyAndAtBat} onDiscard={handleDiscardAllDirtyAndAtBat} message={unsavedChangesMessage} /></>
  }

  if (viewMode === 'game' || !isScorekeeper) {
    return <>{renderGameView()}<UnsavedChangesPrompt blocker={lineupBlocker} onSave={handleSaveAllDirtyAndAtBat} onDiscard={handleDiscardAllDirtyAndAtBat} message={unsavedChangesMessage} /></>
  }

  // ── Scorekeeper mode ────────────────────────────────────────────────────────
  return (
    <div className="scorebook-page-wrapper" style={{ color: C.text, paddingBottom: 90, margin: '-1.25rem -1.25rem 0' }}>
      <UnsavedChangesPrompt blocker={lineupBlocker} onSave={handleSaveAllDirtyAndAtBat} onDiscard={handleDiscardAllDirtyAndAtBat} message={unsavedChangesMessage} />
      {scorebookToolbar}
      {viewTabs}

      {/* ── Sticky header: score + inning strip ── */}
      <div style={{ background: C.bg, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ padding: '8px 12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <StadiumHeaderPill stadium={selectedStadium} isNight={selectedGame?.is_night} onEdit={isScorekeeper ? openStadiumEditModal : undefined} />
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
              <MiniRunnerDiamond runners={displayRunners} charactersById={charactersById} />
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
              // No half-inning is "active" once the game is final, unless the user is
              // deliberately browsing a past inning via viewedInning.
              const isActive = inn === (viewedInning ?? (effectiveGameStatus === 'complete' ? null : currentInning))
              const isExtra  = inn > regulationInnings
              // When looking at the live current inning (not browsing a past one), only the
              // half-inning actually being played should be highlighted, not the whole column.
              const isLiveHalf = isActive && !viewedInning && inn === currentInning && activeBattingSide
              return (
                <div key={inn} onClick={() => setViewedInning(viewedInning === inn ? null : inn)} style={{ display: 'flex', flexDirection: 'column', gap: 2, cursor: 'pointer', width: 30 }}>
                  <div style={{ height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: inn === currentInning ? 700 : 400, color: inn === currentInning ? C.accent : isExtra ? '#F97316' : C.muted, borderBottom: isActive ? `2px solid ${C.accent}` : isExtra ? '2px solid #F97316' : '2px solid transparent' }}>{inn}</div>
                  {lineScoreRows.map((team) => (
                    <div key={team.battingSide} style={{ height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', background: (isLiveHalf ? team.battingSide === activeBattingSide : isActive) ? `${C.accent}20` : 'transparent', border: isExtra ? '1px solid #F9731644' : 'none', borderRadius: 3, fontSize: 13, fontWeight: 700, color: C.text }}>{getLineScoreCellValue({ inning: inn, side: team.battingSide, scoreMap: team.scoreMap, completedHalfCount })}</div>
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

        {/* ── Three-column: batting lineup | diamond | pitching lineup ──
            Hidden once the ball-in-play flow (result picker → build-the-play
            screen) is up — that screen already needs the field diagram,
            runner placement, and Confirm button to fit without scrolling, and
            the lineups aren't actionable mid-play anyway. */}
        {!inPlayState && (
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
        )}

        {selectedGame && !gameLineups.length && !inPlayState && <div style={{ background: C.card, borderRadius: 10, padding: 16, textAlign: 'center', marginBottom: 10, color: C.muted }}>No lineup set.</div>}
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
              <button onClick={() => {
                dismissedGameEndOutsRef.current = outsRecorded
                setGameEndBanner(null)
              }}
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
            <div style={{ background: 'rgba(15,23,42,0.98)', border: `1px solid ${C.border}`, borderRadius: 18, padding: 14, boxShadow: '0 -8px 30px rgba(0,0,0,0.28)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, marginBottom: 12 }}>
                <button type="button" disabled={isSaving || isPitchActionPending} onClick={() => setStarPitchActive((current) => !current)} style={{ width: '100%', minHeight: 68, borderRadius: 16, border: `1px solid ${starPitchActive ? C.accent : C.border}`, background: starPitchActive ? `${C.accent}22` : C.card, color: starPitchActive ? C.accent : C.text, fontWeight: 800, fontSize: 15, opacity: isSaving || isPitchActionPending ? 0.55 : 1, cursor: isSaving || isPitchActionPending ? 'not-allowed' : 'pointer' }}>
                  {starPitchActive ? 'STAR PITCH ON' : 'STAR PITCH'}
                </button>
                <button type="button" disabled={isSaving || isPitchActionPending} onClick={() => setStarHitUsed((current) => {
                  if (current) setStarHitConnected(false)
                  return !current
                })} style={{ width: '100%', minHeight: 68, borderRadius: 16, border: `1px solid ${starHitUsed ? C.accent : C.border}`, background: starHitUsed ? `${C.accent}22` : C.card, color: starHitUsed ? C.accent : C.text, fontWeight: 800, fontSize: 15, opacity: isSaving || isPitchActionPending ? 0.55 : 1, cursor: isSaving || isPitchActionPending ? 'not-allowed' : 'pointer' }}>
                  {starHitUsed ? 'STAR HIT ON' : 'STAR HIT'}
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10, marginBottom: 10 }}>
                <button type="button" onClick={handlePitchBall} disabled={!canRecordOutcome || starHitUsed} style={{ minHeight: 68, borderRadius: 16, border: `1px solid ${starHitUsed ? `${C.border}99` : C.border}`, background: starHitUsed ? 'rgba(148,163,184,0.12)' : `${C.blue}22`, color: starHitUsed ? C.muted : C.blue, fontWeight: 800, fontSize: 15, opacity: !canRecordOutcome || starHitUsed ? 0.55 : 1, cursor: !canRecordOutcome || starHitUsed ? 'not-allowed' : 'pointer' }}>BALL</button>
                <button type="button" onClick={() => handleStrikeChoice('swinging')} disabled={!canRecordOutcome} style={{ minHeight: 68, borderRadius: 16, border: `1px solid ${C.border}`, background: `${C.red}22`, color: C.red, fontWeight: 800, fontSize: 15, opacity: !canRecordOutcome ? 0.55 : 1, cursor: !canRecordOutcome ? 'not-allowed' : 'pointer' }}>SWING</button>
                <button type="button" onClick={() => handleStrikeChoice('looking')} disabled={!canRecordOutcome || starHitUsed} title={starHitUsed ? 'A star hit requires swinging.' : undefined} style={{ minHeight: 68, borderRadius: 16, border: `1px solid ${starHitUsed ? `${C.border}99` : C.border}`, background: starHitUsed ? 'rgba(148,163,184,0.12)' : `${C.red}22`, color: starHitUsed ? C.muted : C.red, fontWeight: 800, fontSize: 15, opacity: !canRecordOutcome || starHitUsed ? 0.55 : 1, cursor: !canRecordOutcome || starHitUsed ? 'not-allowed' : 'pointer' }}>LOOK</button>
                <button type="button" onClick={handlePitchFoul} disabled={!canRecordOutcome} style={{ minHeight: 68, borderRadius: 16, border: `1px solid ${C.border}`, background: `${C.red}22`, color: C.red, fontWeight: 800, fontSize: 15, opacity: !canRecordOutcome ? 0.55 : 1, cursor: !canRecordOutcome ? 'not-allowed' : 'pointer' }}>FOUL</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
                <button type="button" onClick={handlePitchHbp} disabled={!canRecordOutcome || starHitUsed} style={{ minHeight: 68, borderRadius: 16, border: `1px solid ${starHitUsed ? `${C.border}99` : C.border}`, background: starHitUsed ? 'rgba(148,163,184,0.12)' : `${C.blue}22`, color: starHitUsed ? C.muted : C.blue, fontWeight: 800, fontSize: 15, opacity: !canRecordOutcome || starHitUsed ? 0.55 : 1, cursor: !canRecordOutcome || starHitUsed ? 'not-allowed' : 'pointer' }}>HBP</button>
                <button type="button" onClick={handlePitchInPlay} disabled={!canRecordOutcome} style={{ minHeight: 68, borderRadius: 16, border: `1px solid ${C.border}`, background: `${C.green}22`, color: C.green, fontWeight: 800, fontSize: 15, opacity: !canRecordOutcome ? 0.55 : 1, cursor: !canRecordOutcome ? 'not-allowed' : 'pointer' }}>IN PLAY</button>
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
                          const nextState = {
                            ...inPlayState,
                            stage: 'details',
                            resultType: option.resultType,
                            result: option.value,
                            trajectory: option.value === 'GO' ? 'G' : option.value === 'LO' ? 'L' : option.value === 'FO' ? 'F' : null,
                            isBuddyJump: false,
                            robbedHrOverride: null,
                            fielderChain: [],
                            manualRunnerPositions: {},
                            errorMode: false,
                            errorFielderPositions: [],
                            nicePlay: false,
                          }
                          // A ball hit clean over the fence has no fielders to
                          // mark and nothing left to configure — confirm it
                          // immediately instead of landing on an empty details
                          // screen. An inside-the-park HR is a real fielded
                          // play (relay, missed catch, etc.), so it still goes
                          // through fielder selection like any other hit.
                          if (option.value === 'HR') {
                            finalizeInPlay(nextState)
                            return
                          }
                          setInPlayState(nextState)
                        }}
                        style={{
                          minHeight: 64,
                          borderRadius: 16,
                          border: `1px solid ${disabled ? `${C.border}99` : color}`,
                          background: disabled ? 'rgba(148,163,184,0.12)' : `${color}22`,
                          color: disabled ? C.muted : color,
                          fontWeight: 800,
                          fontSize: 15,
                          opacity: disabled ? 0.5 : 1,
                          cursor: disabled ? 'not-allowed' : 'pointer',
                        }}
                      >
                        {option.label}
                      </button>
                    )
                  })}
                </div>
                <button type="button" onClick={cancelInPlaySelection} style={{ width: '100%', minHeight: 56, marginTop: 10, borderRadius: 14, border: `1px solid ${C.border}`, background: C.card, color: C.muted, fontWeight: 700, fontSize: 14 }}>BACK</button>
              </>
            )}
            {inPlayState.stage === 'details' && (
              <div>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: !isHomeRunResult(inPlayState.result) && !isStackedInPlayLayout
                    ? 'minmax(320px, 420px) minmax(320px, 640px) minmax(320px, 420px)'
                    : '1fr',
                  gap: 16,
                  alignItems: 'flex-start',
                  justifyContent: 'center',
                }}>
                  {!isHomeRunResult(inPlayState.result) && !isStackedInPlayLayout ? (
                    runnerPlacementPreview ? (
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, paddingTop: 4 }}>
                        <div style={{ fontSize: 11, fontWeight: 800, color: C.muted, textTransform: 'uppercase', letterSpacing: '.04em' }}>Preview</div>
                        <MiniRunnerDiamond runners={runnerPlacementPreview} charactersById={charactersById} size={120} />
                      </div>
                    ) : <div aria-hidden="true" />
                  ) : null}
                  <div style={{ minWidth: 0, width: '100%', maxWidth: 640, justifySelf: 'center' }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'stretch' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
                        <button
                          type="button"
                          onClick={() => setInPlayState((current) => ({ ...current, nicePlay: !current.nicePlay }))}
                          title="Marks the first fielder to touch the ball as having made a diving/great catch"
                          style={{
                            width: 108,
                            minHeight: 40,
                            padding: '0 12px',
                            borderRadius: 12,
                            border: `1px solid ${inPlayState.nicePlay ? C.accent : C.border}`,
                            background: inPlayState.nicePlay ? `${C.accent}33` : C.card,
                            color: inPlayState.nicePlay ? C.accent : C.muted,
                            fontWeight: 900,
                            fontSize: 12,
                            cursor: 'pointer',
                          }}
                        >
                          {inPlayState.nicePlay ? 'NICE PLAY ON' : 'NICE PLAY'}
                        </button>
                        {BUDDY_JUMP_RESULTS.has(inPlayState.result) && (
                          <button
                            type="button"
                            onClick={() => setInPlayState((current) => ({
                              ...current,
                              isBuddyJump: !current.isBuddyJump,
                              robbedHrOverride: null,
                            }))}
                            title="Marks this catch as a Buddy Jump; tap the assisting fielder first, then the fielder who made the catch"
                            style={{
                              width: 108,
                              minHeight: 40,
                              padding: '0 12px',
                              borderRadius: 12,
                              border: `1px solid ${inPlayState.isBuddyJump ? C.accent : C.border}`,
                              background: inPlayState.isBuddyJump ? `${C.accent}33` : C.card,
                              color: inPlayState.isBuddyJump ? C.accent : C.muted,
                              fontWeight: 900,
                              fontSize: 12,
                              cursor: 'pointer',
                            }}
                          >
                            {inPlayState.isBuddyJump ? 'BJ ON' : 'BJ'}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setInPlayState((current) => ({ ...current, errorMode: !current.errorMode }))}
                          title="While on, tapping a fielder charges them with an error on this play — stays on across multiple taps"
                          style={{
                            width: 108,
                            minHeight: 40,
                            padding: '0 12px',
                            borderRadius: 12,
                            border: `1px solid ${inPlayState.errorMode ? C.red : C.border}`,
                            background: inPlayState.errorMode ? `${C.red}33` : C.card,
                            color: inPlayState.errorMode ? C.red : C.muted,
                            fontWeight: 900,
                            fontSize: 12,
                            cursor: 'pointer',
                          }}
                        >
                          {inPlayState.errorMode ? 'ERROR ON' : 'ERROR'}
                        </button>
                        {inPlayState.isBuddyJump && (
                          <button
                            type="button"
                            onClick={() => setInPlayState((current) => ({ ...current, robbedHrOverride: !buddyJumpEffectiveRobbedHr }))}
                            title="Whether this Buddy Jump catch robbed a home run at the wall — auto-estimated from the catch spot, tap to correct if it's wrong"
                            style={{
                              width: 108,
                              minHeight: 40,
                              padding: '0 12px',
                              borderRadius: 12,
                              border: `1px solid ${buddyJumpEffectiveRobbedHr ? C.accent : C.border}`,
                              background: buddyJumpEffectiveRobbedHr ? `${C.accent}33` : C.card,
                              color: buddyJumpEffectiveRobbedHr ? C.accent : C.muted,
                              fontWeight: 900,
                              fontSize: 12,
                              cursor: 'pointer',
                            }}
                          >
                            {buddyJumpEffectiveRobbedHr ? 'HR ROB ON' : 'HR ROB'}
                          </button>
                        )}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <FieldPlayBuilder
                          fieldersByPosition={activeDefensiveFielders}
                          fielderChain={inPlayState.fielderChain || []}
                          onToggleFielder={(position) => setInPlayState((current) => {
                            const chain = current.fielderChain || []
                            // The same fielder can appear more than once in the chain
                            // (e.g. a 3-4-3 double play), just never twice in a row —
                            // tapping whoever was just tapped is a no-op instead of a
                            // second consecutive touch. Removing a fielder is now a
                            // right-click (see onFielderContextMenu below), so a left
                            // tap always adds another touch rather than toggling one
                            // off.
                            if (chain[chain.length - 1] === position) return current
                            const nextChain = [...chain, position]
                            // Error mode stays on across multiple taps, so every
                            // fielder tapped while it's active gets stacked onto the
                            // same play's error credit rather than replacing whoever
                            // was tapped before them.
                            if (current.errorMode) {
                              const errors = current.errorFielderPositions || []
                              return { ...current, fielderChain: nextChain, errorFielderPositions: errors.includes(position) ? errors : [...errors, position] }
                            }
                            return { ...current, fielderChain: nextChain }
                          })}
                          onFielderContextMenu={(position) => setInPlayState((current) => {
                            const chain = current.fielderChain || []
                            const idx = chain.lastIndexOf(position)
                            if (idx === -1) return current
                            const nextChain = [...chain.slice(0, idx), ...chain.slice(idx + 1)]
                            const errors = (current.errorFielderPositions || []).filter((p) => p !== position)
                            return { ...current, fielderChain: nextChain, errorFielderPositions: errors }
                          })}
                          notation={inPlayState.fielderChain?.length
                            ? assembleErrorNotation(inPlayState.trajectory, inPlayState.fielderChain, effectiveErrorPositions(inPlayState))
                            : ''}
                          accent={C.accent}
                          label={inPlayState.isBuddyJump ? 'Tap Assist, Then The Catch' : inPlayState.result === 'IPHR' ? 'Who Touched The Ball? (Inside-The-Park HR)' : 'Who Touched The Ball?'}
                          stadiumKey={stadiumKey}
                        />
                        {inPlayState.isBuddyJump && (
                          <div style={{ marginTop: 8, fontSize: 11, color: C.muted, textAlign: 'center' }}>
                            Buddy Jump — 1st fielder tapped gets the assist, 2nd gets the putout. Both need good chemistry together.
                            {inPlayState.fielderChain?.length >= 2 && !canFinalizeInPlaySelection(inPlayState, activeDefensiveFielders) && (
                              <div style={{ color: C.red, marginTop: 4, fontWeight: 700 }}>These two don't have chemistry together.</div>
                            )}
                            <div style={{ marginTop: 4 }}>
                              {inPlayState.robbedHrOverride == null
                                ? `HR ROB ${buddyJumpAutoRobbedHr ? 'auto-detected' : 'not detected'} from the catch spot — tap HR ROB to correct it.`
                                : `HR ROB set manually (${buddyJumpEffectiveRobbedHr ? 'on' : 'off'}).`}
                            </div>
                          </div>
                        )}
                        {Boolean(inPlayState.errorFielderPositions?.length) && (
                          <div style={{ marginTop: 8, fontSize: 11, color: C.red, textAlign: 'center', fontWeight: 700 }}>
                            E — {inPlayState.errorFielderPositions.map((position) => activeDefensiveFielders[position]?.character || 'fielder').join(', ')}
                          </div>
                        )}
                        {inPlayState.nicePlay && inPlayState.fielderChain?.[0] && (
                          <div style={{ marginTop: 8, fontSize: 11, color: C.accent, textAlign: 'center', fontWeight: 700 }}>
                            ★ Nice play by {activeDefensiveFielders[inPlayState.fielderChain[0]]?.character || 'fielder'}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  {!isHomeRunResult(inPlayState.result) && (
                    <div style={{
                      minWidth: 0,
                      width: '100%',
                      maxWidth: isStackedInPlayLayout ? undefined : 420,
                      justifySelf: 'stretch',
                      marginTop: isStackedInPlayLayout ? 16 : 0,
                      paddingTop: isStackedInPlayLayout ? 16 : 0,
                      borderTop: isStackedInPlayLayout ? `1px solid ${C.border}` : 'none',
                    }}>
                      <BaserunnerField
                        entries={runnerPlan}
                        charactersById={charactersById}
                        onSetPosition={handleRunnerSetPosition}
                        accent={C.accent}
                      />
                    </div>
                  )}
                </div>
                <div ref={inPlayDetailsFooterRef} style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button type="button" onClick={() => setInPlayState((current) => ({ ...current, stage: 'result', resultType: null, result: null, trajectory: null, fielderChain: [], manualRunnerPositions: {}, errorMode: false, errorFielderPositions: [], nicePlay: false, isBuddyJump: false, robbedHrOverride: null }))} style={{ flex: 1, minHeight: 56, borderRadius: 14, border: `1px solid ${C.border}`, background: C.card, color: C.muted, fontWeight: 700, fontSize: 14 }}>BACK</button>
                  <button type="button" disabled={!canFinalizeInPlaySelection(inPlayState, activeDefensiveFielders)} onClick={() => finalizeInPlay(inPlayState)} style={{ flex: 1, minHeight: 56, borderRadius: 14, border: `1px solid ${C.accent}`, background: `${C.accent}22`, color: C.accent, fontWeight: 800, fontSize: 15, opacity: !canFinalizeInPlaySelection(inPlayState, activeDefensiveFielders) ? 0.5 : 1 }}>CONFIRM</button>
                </div>
              </div>
            )}
          </div>
        )}
        {/* ── Undo + End game ── */}
        {!inPlayState && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <button onClick={handleUndoAction} disabled={!canUndoAction}
              style={{ flex: 1, background: C.card, border: `1px solid ${C.border}`, color: canUndoAction ? C.text : C.muted, borderRadius: 8, padding: '10px 0', fontWeight: 600, cursor: canUndoAction ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 13 }}>
              <RotateCcw size={14} /> Undo
            </button>
            <button onClick={handleRedoAction} disabled={!canRedoUiAction}
              style={{ flex: 1, background: C.card, border: `1px solid ${C.border}`, color: canRedoUiAction ? C.text : C.muted, borderRadius: 8, padding: '10px 0', fontWeight: 600, cursor: canRedoUiAction ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 13 }}>
              <RotateCw size={14} /> Redo
            </button>
            <button onClick={() => setShowEndGameConfirm(true)} disabled={isGameComplete}
              style={{ flex: 1, background: C.card, border: `1px solid ${C.border}`, color: isGameComplete ? C.muted : C.text, borderRadius: 8, padding: '10px 0', fontWeight: 600, cursor: isGameComplete ? 'not-allowed' : 'pointer', fontSize: 13 }}>
              End Game
            </button>
          </div>
        )}
      </div>

      {/* ── Add Game Modal ── */}
      {showAddGame && <AddGameModal players={players} stadiums={stadiums} addGameForm={addGameForm} setAddGameForm={setAddGameForm} onAdd={addGame} onClose={() => setShowAddGame(false)} />}
      {stadiumEditModalOpen && (
        <EditStadiumModal
          stadiums={stadiums}
          stadiumEditForm={stadiumEditForm}
          setStadiumEditForm={setStadiumEditForm}
          onSave={saveStadiumEdit}
          onClose={() => setStadiumEditModalOpen(false)}
          saving={stadiumEditSaving}
        />
      )}

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

// ─── Edit Stadium Modal (fixes a mis-set stadium for the current game) ──────
function EditStadiumModal({ stadiums, stadiumEditForm, setStadiumEditForm, onSave, onClose, saving }) {
  const orderedStadiums = useMemo(() => getOrderedStadiums(stadiums), [stadiums])
  const selectedStadium = orderedStadiums.find((stadium) => String(stadium.id) === String(stadiumEditForm.stadiumId)) || orderedStadiums[0] || null

  const setStadium = (stadium) => {
    setStadiumEditForm((current) => ({
      ...current,
      stadiumId: stadium.id,
      isNight: normalizeIsNightForStadium(stadium, current.isNight),
    }))
  }

  const toggleTime = () => {
    if (!selectedStadium || stadiumTimeToggleDisabled(selectedStadium)) return
    setStadiumEditForm((current) => ({
      ...current,
      isNight: !normalizeIsNightForStadium(selectedStadium, current.isNight),
    }))
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,0.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ background: C.card, borderRadius: 16, padding: 24, width: '100%', maxWidth: 960, maxHeight: '92vh', overflowY: 'auto', border: `1px solid ${C.border}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 18 }}>Edit Stadium</div>
            <div style={{ color: C.muted, fontSize: 12, marginTop: 2 }}>Corrects the stadium on the live game record. A fresh historical row is written when the game is completed.</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: C.muted, cursor: 'pointer' }}><X size={20} /></button>
        </div>

        <StadiumSelectionFields
          stadiums={stadiums}
          selectedStadiumId={stadiumEditForm.stadiumId}
          isNight={stadiumEditForm.isNight}
          onSelectStadium={setStadium}
          onToggleTime={toggleTime}
        />

        <button onClick={onSave} disabled={!selectedStadium || saving} style={{ width: '100%', background: C.accent, color: '#000', border: 'none', borderRadius: 10, padding: '14px 0', fontWeight: 800, fontSize: 16, cursor: selectedStadium && !saving ? 'pointer' : 'not-allowed', marginTop: 20, opacity: selectedStadium && !saving ? 1 : 0.6 }}>
          {saving ? 'Saving…' : 'Save Stadium'}
        </button>
      </div>
    </div>
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
