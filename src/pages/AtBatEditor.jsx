import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowDown, ArrowLeft, ArrowUp, ChevronLeft, ChevronRight, Plus, RotateCcw, Save, Trash2, Video, X } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { fetchAllRows } from '../utils/fetchAllRows'
import { writePitchesWithSchemaFallback } from '../utils/pitchWriteCompatibility'
import FieldPlayBuilder, { FIELD_POSITIONS, STADIUM_CONFIGS, estimateHitDistance, estimateHitAngle, estimateWallDistanceAtAngle } from '../components/FieldPlayBuilder'
import YouTubePlayer from '../components/YouTubePlayer'
import UnsavedChangesPrompt from '../components/UnsavedChangesPrompt'
import { useUnsavedChangesGuard, useConfirmedAction } from '../hooks/useUnsavedChangesGuard'
import { assembleNotation, formatPaResultLabel, formatPitchResultLabel } from '../utils/notation'
import { extractYouTubeId, parseRawClockInput, formatSecondsAsRawInput } from '../utils/video'
import { estimateExitVelocity, exitVelocityDistanceFt, ROBBED_HR_WALL_MARGIN_FT } from '../utils/hitDistanceStats'
import { shouldShowFieldedLocation } from '../utils/fieldedLocation'
import { battedBallResults, calculateOutsForPa, inningsPitchedFromOuts, isCreditedHit } from '../utils/statsCalculator'
import { deriveGameStateAtIndex } from '../utils/trackerGameState'
import { nextPaNumber, runnerAssignmentsForSave } from '../features/scorebook/domain/plateAppearance'
import { fielderCoversPa } from '../utils/fielderStints.js'
import { undoLatestPlateAppearance } from '../features/scorebook/services/plateAppearanceService'
import { syncRunnerOpportunities } from '../utils/runnerOpportunityPersistence'
import { getStadiumKeyByName } from '../utils/stadiums'
import {
  correctionContext,
  correctionInsertionIndex,
  describeUnresolvedPlay,
  draftPitchesFromEvidence,
  fetchUnresolvedPlays,
  recordUnresolvedPlayCorrection,
} from '../utils/trackerUnresolvedPlays'
import {
  computePendingState,
  computePendingOutState,
  extractNextRunners,
  getOutAssignments,
  getPreviewRbiFromAssignments,
  didBatterScore,
  buildRunnerEntriesFromAssignments,
  hydrateRunnerEntries,
  serializeRunnerEntries,
  resolveScoringRunners,
  applyManualRunnerDestination,
  derivePendingResult,
} from '../utils/runnerAssignment'

const TABLES = {
  tournament: { pa: 'plate_appearances', pitches: 'pitches', games: 'games', pitchingStints: 'pitching_stints', runsScored: 'runs_scored', lineups: 'lineups', gameFielders: 'game_fielders' },
  season: { pa: 'season_plate_appearances', pitches: 'season_pitches', games: 'season_schedule', pitchingStints: 'season_pitching_stints', runsScored: 'season_runs_scored', lineups: 'season_lineups', gameFielders: 'season_game_fielders' },
}

const HOMER_RESULTS = new Set(['HR', 'IPHR'])
const CLEARS_BASES = new Set(['HR', 'IPHR', 'TP'])
const HOLDS_RUNNERS = new Set(['K'])
const HIT_LIKE = new Set(['1B', '2B', '3B', 'BB', 'HBP', 'ROE'])
const OUT_LIKE = new Set(['GO', 'FO', 'LO', 'SF', 'SH', 'DP', 'FC'])
const NEEDS_PANEL = new Set(['1B', '2B', '3B', 'GO', 'FO', 'LO', 'SF', 'SH', 'DP', 'FC'])

const TRAJECTORY_OPTIONS = ['G', 'L', 'F', 'B']
const PITCH_RESULT_OPTIONS = ['ball', 'looking', 'swinging_miss', 'strike_unknown', 'foul', 'hbp', 'in_play']
const PITCH_TYPE_OPTIONS = [
  { value: 'fastball', label: 'Fastball', shortLabel: 'FB' },
  { value: 'curveball', label: 'Curveball', shortLabel: 'CB' },
  { value: 'knuckleball', label: 'Knuckleball', shortLabel: 'KN' },
  { value: 'changeup', label: 'Changeup', shortLabel: 'CH' },
]
// Star pitch lives on its own is_star_pitch column, not pitch_type — but a
// pitch is only ever one or the other, so it's offered alongside the other
// pitch types here. Picking it clears pitch_type and vice versa.
const STAR_PITCH_OPTION = { value: 'star', label: 'Star Pitch', shortLabel: 'Star' }
const STRIKEOUT_TYPE_OPTIONS = [{ value: 'KS', label: 'Swinging' }, { value: 'KL', label: 'Looking' }]
const BASE_LABEL = { first: '1st', second: '2nd', third: '3rd', home: 'Home', out: 'Out' }
const RESULT_GROUPS = [
  { label: 'Hit', options: [['1B', 'Single'], ['2B', 'Double'], ['3B', 'Triple'], ['HR', 'Home run'], ['IPHR', 'Inside-park HR']] },
  { label: 'Reach', options: [['BB', 'Walk'], ['HBP', 'Hit by pitch'], ['ROE', 'Error']] },
  { label: 'Out', options: [['K', 'Strikeout'], ['GO', 'Ground out'], ['FO', 'Fly out'], ['LO', 'Line out'], ['FC', "Fielder's choice"]] },
  { label: 'Special', options: [['DP', 'Double play'], ['TP', 'Triple play'], ['SF', 'Sac fly'], ['SH', 'Sac bunt']] },
]
const PITCH_QUICK_OPTIONS = [
  ['ball', 'Ball', 'Ball'],
  ['looking', 'Called strike', 'Called'],
  ['swinging_miss', 'Swing & miss', 'Swing'],
  ['foul', 'Foul', 'Foul'],
  ['hbp', 'Hit batter', 'HBP'],
  ['in_play', 'In play', 'In play'],
]

// Compact override for the video-clock mark buttons — the global
// .ghost-button padding/font-size is sized for normal nav buttons and wraps
// this row once a few of these (each with a timestamp suffix) show at once.
const MARK_BUTTON_BASE_STYLE = { fontSize: 12, padding: '5px 10px', gap: '0.3rem', whiteSpace: 'nowrap' }

// Green/filled once a value is recorded, dashed amber outline while still
// needed — a glance at the row shows what's left without reading every label.
function markButtonStyle(isSet, baseStyle = MARK_BUTTON_BASE_STYLE) {
  return isSet
    ? { ...baseStyle, background: 'rgba(74,222,128,0.16)', borderColor: 'var(--success)', color: 'var(--success)', fontWeight: 700 }
    : { ...baseStyle, borderStyle: 'dashed', borderColor: 'var(--gold)', color: 'var(--gold)' }
}

function recountPitchSequence(pitchRows) {
  let balls = 0
  let strikes = 0
  return pitchRows.map((row, index) => {
    const countBallsBefore = balls
    const countStrikesBefore = strikes
    if (row.result === 'ball') balls = Math.min(4, balls + 1)
    else if (row.result === 'looking' || row.result === 'swinging_miss' || row.result === 'strike_unknown') strikes = Math.min(3, strikes + 1)
    else if (row.result === 'foul') strikes = strikes >= 2 ? 2 : strikes + 1
    return {
      ...row,
      pitch_number_pa: index + 1,
      count_balls_before: countBallsBefore,
      count_strikes_before: countStrikesBefore,
      count_balls_after: balls,
      count_strikes_after: strikes,
    }
  })
}

function blankPitch(result = 'ball') {
  return { result, pitch_type: null, is_star_pitch: false, is_star_swing: false }
}

function pitchTypeValue(pitch) {
  if (!pitch) return null
  return pitch.is_star_pitch ? 'star' : (pitch.pitch_type || null)
}

// Normalizes a saved PA row into the same shape/types the draft uses (DB
// nulls become '' /0/false where the draft's controlled inputs need a
// concrete value) — shared by the initial seed, discard, and the dirty
// comparison below so "no edits yet" reliably reads as clean instead of
// false-positiving on a null-vs-0/false mismatch.
function draftFromPa(pa) {
  return {
    result: pa.result || '',
    trajectory: pa.trajectory,
    hit_x: pa.hit_x, hit_y: pa.hit_y,
    hit_distance_ft: pa.hit_distance_ft, hit_angle_deg: pa.hit_angle_deg,
    fielded_x: pa.fielded_x, fielded_y: pa.fielded_y,
    exit_velocity_mph: pa.exit_velocity_mph, launch_angle_deg: pa.launch_angle_deg,
    hang_time_sec: pa.hang_time_sec,
    contact_video_sec: pa.contact_video_sec, landed_video_sec: pa.landed_video_sec, fielded_video_sec: pa.fielded_video_sec,
    video_timestamp_start_sec: pa.video_timestamp_start_sec, video_timestamp_end_sec: pa.video_timestamp_end_sec,
    rbi: pa.rbi || 0, run_scored: Boolean(pa.run_scored),
    star_hit_used: Boolean(pa.star_hit_used), is_official_ab: Boolean(pa.is_official_ab),
    fielder_choice_out: Boolean(pa.fielder_choice_out),
    is_buddy_jump: Boolean(pa.is_buddy_jump),
    buddy_jump_assist_position: pa.buddy_jump_assist_position,
    buddy_jump_putout_position: pa.buddy_jump_putout_position,
    is_robbed_hr: Boolean(pa.is_robbed_hr), strikeout_type: pa.strikeout_type,
    is_error: Boolean(pa.is_error), error_position: pa.error_position,
  }
}

function emptyDraft() {
  return {
    result: '',
    trajectory: null,
    hit_x: null, hit_y: null, hit_distance_ft: null, hit_angle_deg: null,
    fielded_x: null, fielded_y: null,
    exit_velocity_mph: null, launch_angle_deg: null, hang_time_sec: null,
    contact_video_sec: null, landed_video_sec: null, fielded_video_sec: null,
    video_timestamp_start_sec: null, video_timestamp_end_sec: null,
    rbi: 0, run_scored: false,
    star_hit_used: false, is_official_ab: false, fielder_choice_out: false,
    is_buddy_jump: false, buddy_jump_assist_position: null, buddy_jump_putout_position: null,
    is_robbed_hr: false, strikeout_type: null,
    is_error: false, error_position: null,
  }
}

function markOriginalRunnerPositions(entries) {
  return entries?.map((entry) => ({ ...entry, originalPosition: entry.position })) ?? null
}

function runnerEntriesSnapshot(entries) {
  return JSON.stringify(serializeRunnerEntries(entries))
}

function numericId(value) {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function requiredRows(result, label) {
  if (result?.error) throw new Error(`Could not load ${label}: ${result.error.message || 'unknown error'}`)
  return result?.data
}

// Every field the draft can touch for the current at-bat — compared against
// the saved PA to detect unsaved changes (used for the leave-page guard).
const DIRTY_CHECK_FIELDS = Object.keys(emptyDraft())

function Field({ label, children, className = '' }) {
  return (
    <label className={`at-bat-field ${className}`}>
      <span>{label}</span>
      {children}
    </label>
  )
}

// Standalone editor routes own their router blocker. Keeping this hook in a
// separately mounted component is important: an embedded editor must not
// register even an inactive blocker, because React Router only honors the
// most recently registered blocker and Scorebook already owns that guard.
function AtBatEditorRouteGuard({ isDirty, onSave }) {
  const blocker = useUnsavedChangesGuard(isDirty)
  return (
    <UnsavedChangesPrompt
      blocker={blocker}
      onSave={onSave}
      message="You have unsaved changes to this at-bat. Save them before leaving, or discard them?"
    />
  )
}

// The one-stop editor for a game's plate appearances — create/fix/delete an
// at-bat, resolve runner outcomes, edit its pitch sequence, and (when the
// game has video) mark clip bounds/contact/landed/fielded timestamps and
// hit/fielded location off the broadcast. Works identically:
//  - standalone at /at-bat/:source/:id (jumps straight to that PA)
//  - standalone at /tracker-editor/:source/:gameId (starts at page 0)
//  - embedded in Scorebook's "At-Bat Editor" tab (gameId/source passed directly)
// Self-contained (fetches its own data + realtime subscriptions) rather than
// controlled-by-parent, so the same component works in all three contexts
// without the host needing to already have this game's full PA/pitch state
// loaded.
const AtBatEditor = forwardRef(function AtBatEditor({ source: sourceProp, gameId: gameIdProp, paId: paIdProp, embedded = false, onDirtyChange } = {}, ref) {
  const params = useParams()
  const rawSource = sourceProp ?? params.source
  const gameIdParam = gameIdProp ?? params.gameId ?? null
  const paIdParam = paIdProp ?? params.id ?? null
  const source = rawSource === 'season' ? 'season' : 'tournament'
  const tables = TABLES[source]
  const targetGameId = numericId(gameIdParam)
  const targetPaId = gameIdParam == null ? paIdParam : null
  const targetKey = gameIdParam != null
    ? `${source}:game:${String(gameIdParam)}`
    : targetPaId != null
      ? `${source}:pa:${String(targetPaId)}`
      : `${source}:none`
  // `player`, not `authUser`: corrected_by / resolved_by reference players(id),
  // which is the identity the rest of the scorebook records people by.
  const { isScorekeeper, player } = useAuth()
  const { pushToast } = useToast()
  const canEdit = Boolean(isScorekeeper)

  const mountedRef = useRef(false)
  const targetKeyRef = useRef(targetKey)
  const targetGenerationRef = useRef(0)
  const loadRequestRef = useRef(0)
  const activeLoadRef = useRef(null)
  const loadedSnapshotRef = useRef(null)
  const deepLinkSelectionRef = useRef(null)
  if (targetKeyRef.current !== targetKey) {
    targetKeyRef.current = targetKey
    targetGenerationRef.current += 1
    loadRequestRef.current += 1
    loadedSnapshotRef.current = null
    deepLinkSelectionRef.current = null
  }

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [retryTarget, setRetryTarget] = useState(0)
  const [resolvedTarget, setResolvedTarget] = useState(() => (
    targetGameId == null ? null : { targetKey, source, gameId: targetGameId, targetPaId: null }
  ))
  const resolvedTargetRef = useRef(resolvedTarget)
  resolvedTargetRef.current = resolvedTarget
  const resolvedGameId = resolvedTarget?.targetKey === targetKey ? resolvedTarget.gameId : null
  const [loadedSnapshot, setLoadedSnapshot] = useState(null)
  const [game, setGame] = useState(null)
  const [lineups, setLineups] = useState([])
  const [pas, setPas] = useState([])
  const [pitchesByPaId, setPitchesByPaId] = useState({})
  const [pitchingStints, setPitchingStints] = useState([])
  const [runsScoredRows, setRunsScoredRows] = useState([])
  // Plays the automatic tracker watched and could not score. They are NOT
  // plate appearances and are counted by nobody; they are here so the gap is
  // visible to whoever can answer it, and so the answer lands under the same
  // durable key the tracker used.
  const [unresolvedPlays, setUnresolvedPlays] = useState([])
  const [resolvingPlay, setResolvingPlay] = useState(null)
  const [gameFielderRows, setGameFielderRows] = useState([])
  const [seasonTeamRows, setSeasonTeamRows] = useState([])
  const [charactersById, setCharactersById] = useState({})
  const [playersById, setPlayersById] = useState({})
  const [stadiumsById, setStadiumsById] = useState({})
  const [pageIndex, setPageIndex] = useState(0)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)

  function targetIsCurrent(identity) {
    return Boolean(
      mountedRef.current
      && identity
      && identity.targetKey === targetKeyRef.current
      && identity.generation === targetGenerationRef.current
    )
  }

  function loadIsCurrent(request) {
    return Boolean(
      targetIsCurrent(request)
      && request.requestId === loadRequestRef.current
      && activeLoadRef.current?.requestId === request.requestId
    )
  }

  function clearLoadedData() {
    setGame(null)
    setLineups([])
    setPas([])
    setPitchesByPaId({})
    setPitchingStints([])
    setRunsScoredRows([])
    setUnresolvedPlays([])
    setResolvingPlay(null)
    setGameFielderRows([])
    setSeasonTeamRows([])
    setCharactersById({})
    setPlayersById({})
    setStadiumsById({})
    setPageIndex(0)
  }

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      targetGenerationRef.current += 1
      loadRequestRef.current += 1
      activeLoadRef.current = null
      loadedSnapshotRef.current = null
      deepLinkSelectionRef.current = null
    }
  }, [])

  // A deep-link by PA id (e.g. from a spray chart) only tells us the game
  // indirectly — resolve it once, then hand off to the normal gameId-driven
  // load below. Re-resolves if the target PA id itself changes (a fresh
  // deep link while this component instance is already mounted).
  useEffect(() => {
    const identity = {
      targetKey,
      generation: targetGenerationRef.current,
      source,
      targetPaId: targetPaId == null ? null : String(targetPaId),
    }
    loadRequestRef.current += 1
    activeLoadRef.current = null
    loadedSnapshotRef.current = null
    deepLinkSelectionRef.current = null
    setLoadedSnapshot(null)
    setResolvedTarget(null)
    setLoading(true)
    setLoadError(null)
    clearLoadedData()

    if (gameIdParam != null) {
      if (targetGameId == null) {
        setLoadError({ targetKey, message: 'The game link is invalid. Check the game ID and try again.' })
        setLoading(false)
        return undefined
      }
      setResolvedTarget({ ...identity, gameId: targetGameId })
      return undefined
    }

    if (targetPaId == null) {
      setLoadError({ targetKey, message: 'No game or at-bat was selected.' })
      setLoading(false)
      return undefined
    }

    let cancelled = false
    const resolveDeepLink = async () => {
      try {
        const result = await supabase.from(TABLES[source].pa).select('game_id').eq('id', targetPaId).maybeSingle()
        if (cancelled || !targetIsCurrent(identity)) return
        if (result.error) throw new Error(`Could not resolve the at-bat link: ${result.error.message || 'unknown error'}`)
        const gameId = numericId(result.data?.game_id)
        if (gameId == null) throw new Error('The linked at-bat was not found. It may have been deleted.')
        setResolvedTarget({ ...identity, gameId })
      } catch (error) {
        if (cancelled || !targetIsCurrent(identity)) return
        setLoadError({ targetKey, message: error.message || 'Could not resolve the at-bat link.' })
        setLoading(false)
      }
    }
    void resolveDeepLink()
    return () => { cancelled = true }
    // retryTarget intentionally restarts resolution after an actionable error.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, retryTarget])

  // Applied once per deep-linked PA id, right after that PA's page shows up
  // in the freshly loaded list — cleared afterward so normal Prev/Next
  // browsing isn't yanked back to it.
  async function loadAll(identity = resolvedTargetRef.current) {
    if (!identity || !targetIsCurrent(identity) || identity.gameId == null) return false
    const request = { ...identity, requestId: ++loadRequestRef.current }
    activeLoadRef.current = request
    loadedSnapshotRef.current = null
    setLoadedSnapshot(null)
    setLoading(true)
    setLoadError(null)
    const requestTables = TABLES[request.source]
    try {
    // Fetched alone first (not in the Promise.all below) because the
    // season_teams query needs its season_id to scope by — a player can sit
    // on a different team in every season, so an unscoped fetch keyed by
    // player_id silently resolves to whichever OTHER season's team that
    // player_id last happened to load with (this was the actual cause of
    // fielder portraits going missing on the field diagram: the defensive
    // team id resolved to a team from an unrelated season).
    const gameResult = await supabase.from(requestTables.games).select('*').eq('id', request.gameId).maybeSingle()
    const gameRowOnly = requiredRows(gameResult, 'the game')
    if (!loadIsCurrent(request)) return false
    if (!gameRowOnly) {
      const snapshot = { ...request }
      activeLoadRef.current = null
      loadedSnapshotRef.current = snapshot
      clearLoadedData()
      setLoadedSnapshot(snapshot)
      setLoading(false)
      return true
    }
    if (String(gameRowOnly.id) !== String(request.gameId)) throw new Error('The game response did not match the selected game.')

    const results = await Promise.all([
      Promise.resolve({ data: gameRowOnly, error: null }),
      supabase.from(requestTables.lineups).select('*').eq('game_id', request.gameId).order('batting_order'),
      fetchAllRows(() => supabase.from(requestTables.pa).select('*').eq('game_id', request.gameId)),
      supabase.from(requestTables.pitchingStints).select('*').eq('game_id', request.gameId).order('created_at'),
      supabase.from('characters').select('id,name'),
      supabase.from('players').select('id,name'),
      request.source === 'season' && gameRowOnly.season_id != null
        ? supabase.from('season_teams').select('id,player_id').eq('season_id', gameRowOnly.season_id)
        : Promise.resolve({ data: null, error: null }),
      fetchAllRows(() => supabase.from(requestTables.runsScored).select('*').eq('game_id', request.gameId)),
      fetchAllRows(() => supabase.from(requestTables.gameFielders).select('*').eq('game_id', request.gameId)),
      supabase.from('stadiums').select('id,name'),
    ])
    const labels = ['the game', 'lineups', 'plate appearances', 'pitching stints', 'characters', 'players', 'season teams', 'runs scored', 'game fielders', 'stadiums']
    const [gameRow, lineupRows, paRows, stintRows, characterRows, playerRows, seasonTeamData, runRows, fielderRows, stadiumRows]
      = results.map((result, index) => requiredRows(result, labels[index]))
    if (!loadIsCurrent(request)) return false
    // Deliberately not inside the Promise.all above: a deployment without the
    // migration answers this with "no such table", and that must not take the
    // whole editor down with it.
    const unresolved = await fetchUnresolvedPlays(supabase, {
      competitionType: request.source, gameId: Number(request.gameId),
    })
    if (unresolved.error) throw new Error(`Could not load unresolved plays: ${unresolved.error.message || 'unknown error'}`)
    if (!loadIsCurrent(request)) return false
    // deriveOffense (gameRules.js) expects games-table-shaped team_a_player_id/
    // team_b_player_id — season_schedule instead carries away_team_id/
    // home_team_id pointing at season_teams, so normalize into the same shape
    // here (same translation Scorebook.jsx's session provider does before
    // ever handing a season game row to deriveOffense).
    const normalizedGame = gameRow && request.source === 'season'
      ? (() => {
          const playerIdByTeamId = Object.fromEntries((seasonTeamData || []).map((t) => [String(t.id), t.player_id]))
          return {
            ...gameRow,
            team_a_player_id: playerIdByTeamId[String(gameRow.away_team_id)] ?? null,
            team_b_player_id: playerIdByTeamId[String(gameRow.home_team_id)] ?? null,
          }
        })()
      : gameRow
    const orderedPas = (paRows || []).slice().sort((a, b) => Number(a.pa_number) - Number(b.pa_number))
    const pitchResult = orderedPas.length
      ? await fetchAllRows(() => supabase.from(requestTables.pitches).select('*').in('pa_id', orderedPas.map((p) => p.id)))
      : { data: [], error: null }
    const pitchRows = requiredRows(pitchResult, 'pitches')
    if (!loadIsCurrent(request)) return false
    const scopedCollections = [
      ['lineup', lineupRows],
      ['plate appearance', orderedPas],
      ['pitching stint', stintRows],
      ['run-scored', runRows],
      ['game-fielder', fielderRows],
    ]
    for (const [label, rows] of scopedCollections) {
      if ((rows || []).some((row) => String(row.game_id) !== String(request.gameId))) {
        throw new Error(`A ${label} response did not match the selected game.`)
      }
    }
    const paIds = new Set(orderedPas.map((pa) => String(pa.id)))
    if ((pitchRows || []).some((pitch) => !paIds.has(String(pitch.pa_id)))) {
      throw new Error('A pitch response did not match the selected game.')
    }
    if (request.targetPaId != null && !orderedPas.some((pa) => String(pa.id) === String(request.targetPaId))) {
      throw new Error('The linked at-bat was not found in its game. It may have been deleted.')
    }
    const grouped = {}
    for (const row of (pitchRows || [])) {
      const key = String(row.pa_id)
      if (!grouped[key]) grouped[key] = []
      grouped[key].push(row)
    }
    Object.keys(grouped).forEach((key) => {
      grouped[key].sort((a, b) => Number(a.pitch_number_pa) - Number(b.pitch_number_pa))
    })

    if (!loadIsCurrent(request)) return false
    setUnresolvedPlays(unresolved.rows)
    setGame(normalizedGame || null)
    setLineups(lineupRows || [])
    setPas(orderedPas)
    setPitchesByPaId(grouped)
    setPitchingStints(stintRows || [])
    setRunsScoredRows(runRows || [])
    setGameFielderRows(fielderRows || [])
    setSeasonTeamRows(seasonTeamData || [])
    setCharactersById(Object.fromEntries((characterRows || []).map((c) => [String(c.id), c])))
    setPlayersById(Object.fromEntries((playerRows || []).map((p) => [String(p.id), p])))
    setStadiumsById(Object.fromEntries((stadiumRows || []).map((s) => [String(s.id), s])))
    if (request.targetPaId != null && deepLinkSelectionRef.current !== request.targetKey) {
      setPageIndex(orderedPas.findIndex((p) => String(p.id) === String(request.targetPaId)))
      deepLinkSelectionRef.current = request.targetKey
    } else {
      setPageIndex((current) => Math.min(current, orderedPas.length))
    }
    const snapshot = { ...request }
    activeLoadRef.current = null
    loadedSnapshotRef.current = snapshot
    setLoadedSnapshot(snapshot)
    setLoading(false)
    return true
    } catch (error) {
      if (!loadIsCurrent(request)) return false
      console.error(error)
      activeLoadRef.current = null
      loadedSnapshotRef.current = null
      clearLoadedData()
      setLoadedSnapshot(null)
      setLoadError({ targetKey: request.targetKey, message: error.message || 'Could not load the selected game.' })
      setLoading(false)
      return false
    }
  }

  useEffect(() => {
    if (resolvedTarget?.targetKey === targetKey) void loadAll(resolvedTarget)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedTarget, targetKey])

  // Realtime: a fresh at-bat inserted by the tracker bridge, or a lineup/
  // fielding change made in Scorebook, while this page is open should show
  // up without a manual refresh.
  useEffect(() => {
    if (!resolvedTarget || resolvedTarget.targetKey !== targetKey) return undefined
    const identity = resolvedTarget
    const reloadUnlessSaving = () => {
      if (!savingRef.current && targetIsCurrent(identity)) void loadAll(identity)
    }
    const channel = supabase
      .channel(`at-bat-editor-${identity.source}-${identity.gameId}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: TABLES[identity.source].lineups, filter: `game_id=eq.${identity.gameId}` }, reloadUnlessSaving)
      .on('postgres_changes', { event: '*', schema: 'public', table: TABLES[identity.source].gameFielders, filter: `game_id=eq.${identity.gameId}` }, reloadUnlessSaving)
      .on('postgres_changes', { event: '*', schema: 'public', table: TABLES[identity.source].pa, filter: `game_id=eq.${identity.gameId}` }, reloadUnlessSaving)
      .on('postgres_changes', { event: '*', schema: 'public', table: TABLES[identity.source].pitches, filter: `game_id=eq.${identity.gameId}` }, reloadUnlessSaving)
      .subscribe()
    return () => supabase.removeChannel(channel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedTarget, targetKey])

  // WHERE THE ANSWER GOES, AND WHAT IT IS ANSWERED IN.
  //
  // `startResolvingPlay` used to open the append page (`pageIndex = pas.length`)
  // and set the batter and pitcher by hand -- and the draft-seed effect below,
  // which runs on every page change, immediately overwrote both from the state
  // derived at the END of the game. An unresolved Top 5 play was then recorded
  // as Bottom 9 with the ninth-inning batter, the ninth-inning pitcher, no
  // pitches and empty bases. Nothing in that page came from the play.
  //
  // Half-innings here are derived from the running out count rather than read
  // off the `inning` column, so the slot is not a display choice: recorded at
  // the end of the list, a fifth-inning plate appearance also moves every later
  // at-bat's derived inning once it carries outs.
  const correctionSlot = useMemo(() => {
    if (!resolvingPlay || !game) return null
    return correctionInsertionIndex({
      unresolved: resolvingPlay,
      paCount: pas.length,
      deriveAt: (index) => deriveGameStateAtIndex(pas, game, lineups, index, runsScoredRows),
    })
  }, [resolvingPlay, pas, game, lineups, runsScoredRows])

  const derived = useMemo(() => {
    if (!game) return null
    const at = correctionSlot == null ? pageIndex : correctionSlot
    const state = deriveGameStateAtIndex(pas, game, lineups, at, runsScoredRows)
    return correctionSlot == null ? state : correctionContext(resolvingPlay, state)
  }, [pas, game, lineups, pageIndex, runsScoredRows, correctionSlot, resolvingPlay])

  // Tournament team ids on game_fielders rows are the owning player id
  // directly; season team ids point at season_teams, so map back to a
  // player id the same way the offense/derived state already does.
  const teamIdByPlayerId = useMemo(() => {
    if (source !== 'season') return null
    return Object.fromEntries(seasonTeamRows.map((t) => [String(t.player_id), t.id]))
  }, [source, seasonTeamRows])

  // Which fielder currently holds each defensive position, for the field
  // diagram's portraits — same inning-ranged lookup Scorebook's live
  // activeDefensiveFielders uses, applied to whichever PA page is showing.
  const activeDefensiveFielders = useMemo(() => {
    if (!derived) return {}
    const defensiveTeamId = source === 'season'
      ? teamIdByPlayerId?.[String(derived.pitchingPlayerId)] ?? null
      : derived.pitchingPlayerId
    // The PA this page shows: a saved one, the slot a correction is being
    // inserted at (it takes that slot's number), or the next one to be written.
    const shownPa = pas[correctionSlot == null ? pageIndex : correctionSlot]
    const shownAt = { inning: derived.inning, pa_number: shownPa ? shownPa.pa_number : nextPaNumber(pas) }
    return gameFielderRows.reduce((acc, row) => {
      if (String(row.team_id) === String(defensiveTeamId) && fielderCoversPa(row, shownAt)) {
        acc[String(row.position)] = row
      }
      return acc
    }, {})
  }, [gameFielderRows, derived, source, teamIdByPlayerId, pas, pageIndex, correctionSlot])

  // A correction is always a NEW plate appearance, even though its slot sits in
  // the middle of the list: the row at that index is the at-bat it goes BEFORE.
  const isCorrecting = correctionSlot != null
  const currentPa = isCorrecting ? null : (pas[pageIndex] || null)
  const isNewPage = isCorrecting || pageIndex === pas.length
  const isLastPage = !isCorrecting && pageIndex === pas.length - 1
  const snapshotMatchesTarget = Boolean(
    loadedSnapshot
    && loadedSnapshot === loadedSnapshotRef.current
    && targetIsCurrent(loadedSnapshot)
    && loadedSnapshot.source === source
    && String(loadedSnapshot.gameId) === String(resolvedGameId)
    && !activeLoadRef.current
  )

  // Prefer the PA's own recorded stadium (the park a past hit was actually
  // measured against) but fall back to the game's current stadium — without
  // this, an at-bat with no hit tapped yet (or an older PA saved before
  // hit_stadium_key existed) showed the bare generic field art instead of
  // this game's actual park, which read as broken rather than just "no
  // stadium picked yet."
  // season_schedule stores the stadium as a name string directly (`stadium`);
  // the tournament `games` table instead points at the stadiums table via
  // `stadium_id` — same two shapes SeasonGameSessionProvider normalizes for
  // Scorebook, replicated here since this component loads its own game row.
  const gameStadiumKey = source === 'season'
    ? getStadiumKeyByName(game?.stadium)
    : (game?.stadium_id ? getStadiumKeyByName(stadiumsById[String(game.stadium_id)]?.name) : null)
  const resolvedStadiumKey = currentPa?.hit_stadium_key || gameStadiumKey

  const [draft, setDraft] = useState(emptyDraft)
  const [draftBatter, setDraftBatter] = useState(null)
  const [draftPitcher, setDraftPitcher] = useState(null)
  const [draftPitches, setDraftPitches] = useState([])
  const [runnerEntries, setRunnerEntries] = useState(null)
  const runnerEntriesBaselineRef = useRef(null)
  const runnerEntriesOriginalRef = useRef(null)
  const runnerOverridesRef = useRef(new Map())
  const shouldSyncOutcomeRef = useRef(false)
  const [editingClipBounds, setEditingClipBounds] = useState(false)
  const clipPlayerRef = useRef(null)

  const videoId = useMemo(() => extractYouTubeId(game?.video_url), [game])

  // Reset the editable draft whenever the visible page changes — seeded from
  // the existing PA row, or from derived defaults for a not-yet-created page.
  useEffect(() => {
    if (!derived) return
    shouldSyncOutcomeRef.current = false
    if (resolvingPlay) {
      // The batter, the pitcher and the pitches are what the tracker DID see
      // and are evidence. The result is not, and is deliberately left blank:
      // an unresolved play that arrived pre-filled with a guess would be
      // exactly the inference this whole path exists to avoid.
      setDraft(emptyDraft())
      setDraftBatter(resolvingPlay.batter_character_id == null ? null : {
        characterId: resolvingPlay.batter_character_id,
        playerId: resolvingPlay.batter_player_id ?? null,
      })
      setDraftPitcher(resolvingPlay.pitcher_character_id == null ? null : {
        characterId: resolvingPlay.pitcher_character_id,
        playerId: resolvingPlay.pitcher_player_id ?? null,
      })
      setDraftPitches(draftPitchesFromEvidence(resolvingPlay))
    } else if (currentPa) {
      setDraft(draftFromPa(currentPa))
      setDraftBatter({ characterId: currentPa.character_id, playerId: currentPa.player_id })
      setDraftPitcher({ characterId: currentPa.pitcher_id, playerId: currentPa.pitcher_player_id })
      setDraftPitches(pitchesByPaId[String(currentPa.id)] || [])
    } else {
      setDraft(emptyDraft())
      setDraftBatter(derived.batter ? { characterId: derived.batter.character_id, playerId: derived.batter.player_id } : null)
      const activeStint = pitchingStints
        .filter((s) => String(s.player_id) === String(derived.pitchingPlayerId))
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        .pop()
      setDraftPitcher(activeStint ? { characterId: activeStint.character_id, playerId: activeStint.player_id } : null)
      setDraftPitches([])
    }
    runnerEntriesBaselineRef.current = null
    runnerEntriesOriginalRef.current = null
    runnerOverridesRef.current = new Map()
    setRunnerEntries(null)
    setEditingClipBounds(false)
    // resolvingPlay?.id is in the list on purpose: opening a correction has to
    // re-seed the draft, and this effect is what would otherwise run afterwards
    // and overwrite the play's own batter and pitcher with the derived ones.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageIndex, currentPa?.id, derived?.batter?.character_id, pitchesByPaId, resolvingPlay?.id])

  // Build (or rebuild) the runner-resolution panel whenever the chosen result
  // or the derived runners-before state changes for a result that needs it.
  useEffect(() => {
    if (!derived || !draftBatter?.characterId || !NEEDS_PANEL.has(draft.result)) {
      // Clear the saved comparison baseline as well as the rendered rows.
      // During PA navigation, this effect can briefly run with the previous
      // PA's result after the seed effect has reset the refs. Without clearing
      // here too, a panel result (for example DP) can leave an invisible
      // runner snapshot behind on the following HR and mark it dirty forever.
      runnerEntriesBaselineRef.current = runnerEntriesSnapshot(null)
      runnerEntriesOriginalRef.current = null
      runnerOverridesRef.current = new Map()
      setRunnerEntries(null)
      return
    }
    const batterRunner = { characterId: draftBatter.characterId, playerId: draftBatter.playerId }
    const pending = HIT_LIKE.has(draft.result)
      ? computePendingState(draft.result, derived.runnersBefore, batterRunner)
      : computePendingOutState(draft.result, derived.runnersBefore, batterRunner)
    const defaults = buildRunnerEntriesFromAssignments(pending, derived.runnersBefore)
    const matchesSavedPlay = currentPa
      && currentPa.result === draft.result
      && String(currentPa.character_id) === String(draftBatter.characterId)
    const nextEntries = matchesSavedPlay
      ? hydrateRunnerEntries(defaults, currentPa.runner_assignments)
      : defaults
    const entriesWithOriginals = markOriginalRunnerPositions(nextEntries)
    runnerEntriesBaselineRef.current = runnerEntriesSnapshot(entriesWithOriginals)
    runnerEntriesOriginalRef.current = entriesWithOriginals
    runnerOverridesRef.current = new Map()
    setRunnerEntries(entriesWithOriginals)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.result, derived?.runnersBefore, draftBatter?.characterId, currentPa?.runner_assignments])

  function nameFor(characterId, playerId) {
    const charName = charactersById[String(characterId)]?.name || '—'
    const playerName = playersById[String(playerId)]?.name
    return playerName ? `${charName} (${playerName})` : charName
  }

  // Distance and hang time fully determine launch speed/angle for a given
  // batted-ball shape (same real projectile-physics model for every
  // trajectory, grounders included), so keep exit velocity/launch angle in
  // sync whenever either input (or the shape) changes. fielded_x/y never
  // feeds this — it's a different point on the play than what hang_time_sec
  // measures, read only by fieldingRange.js for Range Runs. is_robbed_hr
  // substitutes the assumed true distance instead of the truncated
  // catch-spot hit_distance_ft.
  function recomputeShotShape(patch) {
    setDraft((d) => {
      const next = { ...d, ...patch }
      // Older Buddy Jumps were recorded before their FO/LO shape was known —
      // resolving the trajectory here (the only new signal in that flow)
      // keeps result/hit_notation in sync, same as when a batter/pitcher
      // pick or a manual result pick already do. A Buddy Jump recorded on a
      // sacrifice fly must stay SF, or this would silently remove the
      // batter's sacrifice credit.
      if (next.is_buddy_jump && Object.prototype.hasOwnProperty.call(patch, 'trajectory') && patch.trajectory) {
        next.result = d.result === 'SF' ? 'SF' : (patch.trajectory === 'L' ? 'LO' : 'FO')
      }
      const config = resolvedStadiumKey ? STADIUM_CONFIGS[resolvedStadiumKey] : null
      const distanceFt = exitVelocityDistanceFt({
        isRobbedHr: next.is_robbed_hr,
        hitDistanceFt: next.hit_distance_ft,
        hitAngleDeg: next.hit_angle_deg,
      }, config)
      const estimate = estimateExitVelocity(distanceFt, next.hang_time_sec)
      return { ...next, exit_velocity_mph: estimate?.exitVelocityMph ?? null, launch_angle_deg: estimate?.launchAngleDeg ?? null }
    })
  }

  function handleFieldTap(spot) {
    const config = resolvedStadiumKey ? STADIUM_CONFIGS[resolvedStadiumKey] : null
    const newDistanceFt = config ? estimateHitDistance(spot, config) : null
    const hitAngleDeg = config ? estimateHitAngle(spot, config) : null
    recomputeShotShape({ hit_x: spot.x, hit_y: spot.y, hit_distance_ft: newDistanceFt, hit_angle_deg: hitAngleDeg })
  }

  // Where the ball was actually secured, separate from hit_x/hit_y — purely
  // positional, feeds fieldingRange.js's Range Runs (paired with
  // fielded_video_sec below when that's marked too).
  function handleFieldedTap(spot) {
    setDraft((d) => ({ ...d, fielded_x: spot.x, fielded_y: spot.y }))
  }

  const stadiumConfigForMarks = resolvedStadiumKey ? STADIUM_CONFIGS[resolvedStadiumKey] : null
  const autoRobbedHr = (() => {
    if (!stadiumConfigForMarks || draft.hit_distance_ft == null || draft.hit_angle_deg == null) return false
    const wallDistanceFt = estimateWallDistanceAtAngle(draft.hit_angle_deg, stadiumConfigForMarks)
    return wallDistanceFt != null && draft.hit_distance_ft >= wallDistanceFt - ROBBED_HR_WALL_MARGIN_FT
  })()

  // Beginning/end-of-at-bat marks, read from the full (unbounded) video
  // player while no clip exists yet for this PA.
  function markClipBound(field) {
    const current = clipPlayerRef.current?.getCurrentTime?.()
    if (current == null) { pushToast({ title: 'Video not ready', type: 'error' }); return }
    const seconds = Math.round(current * 100) / 100
    const textField = field.replace('_sec', '_text')
    setDraft((d) => ({ ...d, [field]: seconds, [textField]: undefined }))
  }

  // Contact/landed marks are read from the clip-bounded player.
  function markHangTime(field) {
    const current = clipPlayerRef.current?.getCurrentTime?.()
    if (current == null) { pushToast({ title: 'Video not ready', type: 'error' }); return }
    const seconds = Math.round(current * 1000) / 1000
    setDraft((d) => {
      const next = { ...d, [field]: seconds }
      const hangTimeSec = next.contact_video_sec != null && next.landed_video_sec != null
        ? Math.round((next.landed_video_sec - next.contact_video_sec) * 1000) / 1000
        : next.hang_time_sec
      next.hang_time_sec = hangTimeSec
      const config = resolvedStadiumKey ? STADIUM_CONFIGS[resolvedStadiumKey] : null
      const distanceFt = exitVelocityDistanceFt({ isRobbedHr: next.is_robbed_hr, hitDistanceFt: next.hit_distance_ft, hitAngleDeg: next.hit_angle_deg }, config)
      const estimate = estimateExitVelocity(distanceFt, next.hang_time_sec)
      return { ...next, exit_velocity_mph: estimate?.exitVelocityMph ?? null, launch_angle_deg: estimate?.launchAngleDeg ?? null }
    })
  }

  function markFieldedTime() {
    const current = clipPlayerRef.current?.getCurrentTime?.()
    if (current == null) { pushToast({ title: 'Video not ready', type: 'error' }); return }
    const seconds = Math.round(current * 1000) / 1000
    setDraft((d) => ({ ...d, fielded_video_sec: seconds }))
  }

  function clearClipBounds() {
    setDraft((d) => ({ ...d, video_timestamp_start_sec: null, video_timestamp_end_sec: null, video_timestamp_start_text: undefined, video_timestamp_end_text: undefined }))
    setEditingClipBounds(false)
  }

  // ── Pitch editing ──────────────────────────────────────────────────────
  // Every pitch change stays local until the at-bat's Save button is used.
  // Recomputes the game's total score from every remaining PA's own rbi/
  // run_scored. Called after every save AND every delete.
  async function recomputeGameScore() {
    const { data: allPAs } = await fetchAllRows(() => supabase.from(tables.pa).select('*').eq('game_id', resolvedGameId))
    const isHomer = (pa) => HOMER_RESULTS.has(pa.result)
    const runsForPlayer = (playerId) => (allPAs || [])
      .filter((pa) => String(pa.player_id) === String(playerId))
      .reduce((sum, pa) => sum + Number(pa.rbi || 0) + (pa.run_scored && !isHomer(pa) ? 1 : 0), 0)
    if (source === 'season') {
      const { data: seasonTeamRowsFresh } = await supabase.from('season_teams').select('id,player_id')
      const teamPlayerId = Object.fromEntries((seasonTeamRowsFresh || []).map((t) => [String(t.id), t.player_id]))
      await supabase.from(tables.games).update({
        away_score: runsForPlayer(teamPlayerId[String(game.away_team_id)]),
        home_score: runsForPlayer(teamPlayerId[String(game.home_team_id)]),
      }).eq('id', resolvedGameId)
    } else {
      await supabase.from(tables.games).update({
        team_a_runs: runsForPlayer(game.team_a_player_id),
        team_b_runs: runsForPlayer(game.team_b_player_id),
      }).eq('id', resolvedGameId)
    }
  }

  // Full from-scratch recompute of every pitching_stints row for the game —
  // Deleting an at-bat, editing its result, or changing its pitch sequence
  // also has to correct hits/runs/walks/
  // strikeouts/HR-allowed/innings-pitched, which nothing else here tracks
  // incrementally — so this runs once at the end of every save/delete to
  // make the whole game's pitching lines authoritative again.
  async function recomputePitchingStintsForGame() {
    const [{ data: stints }, { data: gamePas }, { data: runs }, { data: pitchRows }] = await Promise.all([
      supabase.from(tables.pitchingStints).select('*').eq('game_id', resolvedGameId),
      fetchAllRows(() => supabase.from(tables.pa).select('*').eq('game_id', resolvedGameId)),
      fetchAllRows(() => supabase.from(tables.runsScored).select('*').eq('game_id', resolvedGameId)),
      fetchAllRows(() => supabase.from(tables.pitches).select('*').eq('game_id', resolvedGameId)),
    ])
    if (!stints || !stints.length) return

    const sortedStints = [...stints].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    const sortedPAs = [...(gamePas || [])].sort((a, b) => Number(a.pa_number) - Number(b.pa_number))
    const statsByStintId = Object.fromEntries(sortedStints.map((s) => [s.id, {
      innings_pitched: 0, hits_allowed: 0, runs_allowed: 0, earned_runs: 0,
      walks: 0, strikeouts: 0, hr_allowed: 0, pitches_thrown: 0, strikes_thrown: 0, _outs: 0,
    }]))

    const stintFor = (characterId, atOrBefore) => {
      const eligible = sortedStints.filter((s) => (
        String(s.character_id) === String(characterId) && new Date(s.created_at).getTime() <= new Date(atOrBefore).getTime()
      ))
      return eligible[eligible.length - 1] || null
    }

    for (const pa of sortedPAs) {
      const activeStint = pa.pitcher_id != null ? stintFor(pa.pitcher_id, pa.created_at) : null
      if (!activeStint) continue
      const stat = statsByStintId[activeStint.id]
      stat._outs += calculateOutsForPa(pa.result, pa.outs_on_play)
      if (isCreditedHit(pa)) stat.hits_allowed += 1
      if (isCreditedHit(pa) && HOMER_RESULTS.has(pa.result)) stat.hr_allowed += 1
      if (pa.result === 'BB') stat.walks += 1
      if (pa.result === 'K') stat.strikeouts += 1

      const paPitches = (pitchRows || []).filter((p) => String(p.pa_id) === String(pa.id))
      stat.pitches_thrown += paPitches.length
      stat.strikes_thrown += paPitches.filter((p) => p.result !== 'ball' && p.result !== 'hbp').length

      const paRuns = (runs || []).filter((r) => String(r.pa_id) === String(pa.id))
      for (const run of paRuns) {
        let target = stat
        if (String(run.charged_to_pitcher_id) !== String(activeStint.character_id)) {
          const chargedStint = stintFor(run.charged_to_pitcher_id, pa.created_at)
          if (chargedStint) target = statsByStintId[chargedStint.id]
        }
        target.runs_allowed += 1
        if (run.is_earned_run !== false) target.earned_runs += 1
      }
    }

    await Promise.all(sortedStints.map((s) => {
      const { _outs, ...rest } = statsByStintId[s.id]
      rest.innings_pitched = inningsPitchedFromOuts(_outs)
      return supabase.from(tables.pitchingStints).update(rest).eq('id', s.id)
    }))
  }

  function findActivePitcherStint() {
    if (!draftPitcher?.characterId) return null
    return pitchingStints.find((s) => String(s.character_id) === String(draftPitcher.characterId) && String(s.player_id) === String(draftPitcher.playerId)) || null
  }

  // The same shapes persistDraftPitches and the runs block below write, without
  // the writes. The correction path hands its children to one transactional
  // function instead of inserting them itself, and sharing the row builders is
  // what stops the two paths drifting into recording a pitch differently.
  function correctionPitchValues(pitch) {
    return {
      pitcher_id: charactersById[String(draftPitcher?.characterId)]?.name || '',
      pitcher_player: playersById[String(draftPitcher?.playerId)]?.name || '',
      batter_id: charactersById[String(draftBatter?.characterId)]?.name || '',
      inning: derived.inning,
      half: derived.isTop ? 'top' : 'bottom',
      pitch_number_pa: pitch.pitch_number_pa,
      is_star_pitch: Boolean(pitch.is_star_pitch),
      is_star_swing: Boolean(pitch.is_star_swing),
      result: pitch.result,
      pitch_type: pitch.pitch_type || null,
      count_balls_before: pitch.count_balls_before,
      count_strikes_before: pitch.count_strikes_before,
      count_balls_after: pitch.count_balls_after,
      count_strikes_after: pitch.count_strikes_after,
    }
  }

  function correctionRunsPayload() {
    if (!outcome?.scoredRunnerIds?.length) return []
    const stint = findActivePitcherStint()
    return resolveScoringRunners(
      outcome.scoredRunnerIds,
      currentAssignments(),
      derived.runnersBefore,
      { characterId: draftBatter.characterId, playerId: draftBatter.playerId },
    ).map((runner) => ({
      game_id: resolvedGameId, inning: derived.inning, half: derived.isTop ? 'top' : 'bottom',
      scoring_player_id: runner.playerId, scoring_character_id: runner.characterId,
      charged_to_pitcher_id: runner.chargedToPitcherId ?? stint?.character_id ?? draftPitcher?.characterId ?? null,
      charged_to_pitcher_player_id: runner.chargedToPitcherPlayerId ?? stint?.player_id ?? draftPitcher?.playerId ?? null,
      is_earned_run: !runner.reachedOnError,
      ...(source === 'season' && game?.season_id != null ? { season_id: game.season_id } : {}),
    }))
  }

  async function persistDraftPitches(savedPa) {
    const rows = recountPitchSequence(draftPitches)
    const originalRows = currentPa ? (pitchesByPaId[String(currentPa.id)] || []) : []
    const originalIds = new Set(originalRows.map((pitch) => String(pitch.id)))
    const retainedIds = new Set(rows
      .filter((pitch) => pitch.id != null && originalIds.has(String(pitch.id)))
      .map((pitch) => String(pitch.id)))
    const removedIds = originalRows
      .filter((pitch) => !retainedIds.has(String(pitch.id)))
      .map((pitch) => pitch.id)

    if (removedIds.length) {
      const { error } = await supabase.from(tables.pitches).delete().in('id', removedIds)
      if (error) throw error
    }

    const valuesFor = (pitch) => ({
      pitcher_id: charactersById[String(draftPitcher?.characterId)]?.name || '',
      pitcher_player: playersById[String(draftPitcher?.playerId)]?.name || '',
      batter_id: charactersById[String(draftBatter?.characterId)]?.name || '',
      inning: derived.inning,
      half: derived.isTop ? 'top' : 'bottom',
      pitch_number_pa: pitch.pitch_number_pa,
      is_star_pitch: Boolean(pitch.is_star_pitch),
      is_star_swing: Boolean(pitch.is_star_swing),
      result: pitch.result,
      pitch_type: pitch.pitch_type || null,
      count_balls_before: pitch.count_balls_before,
      count_strikes_before: pitch.count_strikes_before,
      count_balls_after: pitch.count_balls_after,
      count_strikes_after: pitch.count_strikes_after,
    })

    const existingRows = rows.filter((pitch) => pitch.id != null && originalIds.has(String(pitch.id)))
    const updateResults = await Promise.all(existingRows.map((pitch) => (
      writePitchesWithSchemaFallback(
        (payload) => supabase.from(tables.pitches).update(payload).eq('id', pitch.id),
        valuesFor(pitch),
      )
    )))
    const updateError = updateResults.find((result) => result.error)?.error
    if (updateError) throw updateError

    const newRows = rows.filter((pitch) => pitch.id == null || !originalIds.has(String(pitch.id)))
    if (newRows.length) {
      const { data: latestGamePitch, error: latestPitchError } = await supabase
        .from(tables.pitches).select('pitch_number_game').eq('game_id', resolvedGameId)
        .order('pitch_number_game', { ascending: false }).limit(1).maybeSingle()
      if (latestPitchError) throw latestPitchError
      let nextPitchNumberGame = Number(latestGamePitch?.pitch_number_game || 0)
      const insertPayload = newRows.map((pitch) => ({
        ...valuesFor(pitch),
        game_id: resolvedGameId,
        pa_id: savedPa.id,
        pitch_number_game: ++nextPitchNumberGame,
      }))
      const { error } = await writePitchesWithSchemaFallback(
        (payload) => supabase.from(tables.pitches).insert(payload),
        insertPayload,
      )
      if (error) throw error
    }
  }

  function addPitchAt(atIndex, result = 'ball') {
    setDraftPitches((rows) => recountPitchSequence([...rows.slice(0, atIndex), blankPitch(result), ...rows.slice(atIndex)]))
  }

  function removePitchAt(atIndex) {
    setDraftPitches((rows) => recountPitchSequence(rows.filter((_, index) => index !== atIndex)))
  }

  function updatePitchAt(atIndex, patch) {
    setDraftPitches((rows) => {
      const normalized = { ...patch }
      if (normalized.pitch_type) normalized.is_star_pitch = false
      if (normalized.is_star_pitch) normalized.pitch_type = null
      const nextRows = rows.map((row, index) => (index === atIndex ? { ...row, ...normalized } : row))
      return Object.prototype.hasOwnProperty.call(normalized, 'result') ? recountPitchSequence(nextRows) : nextRows
    })
  }

  // Quick-select toggle for a pitch's type/star badge — clicking the already-
  // selected option clears it, same as a normal toggle button.
  function handlePitchTypeSelect(pitch, atIndex, value) {
    const currentValue = pitch.is_star_pitch ? 'star' : pitch.pitch_type
    const nextValue = currentValue === value ? null : value
    updatePitchAt(atIndex, nextValue === 'star' ? { pitch_type: null, is_star_pitch: true } : { pitch_type: nextValue, is_star_pitch: false })
  }

  function movePitchAt(atIndex, direction) {
    const targetIndex = atIndex + (direction === 'up' ? -1 : 1)
    if (targetIndex < 0 || targetIndex >= draftPitches.length) return
    const nextRows = [...draftPitches]
    ;[nextRows[atIndex], nextRows[targetIndex]] = [nextRows[targetIndex], nextRows[atIndex]]
    setDraftPitches(recountPitchSequence(nextRows))
  }

  // ── Runner panel helpers ───────────────────────────────────────────────
  function currentAssignments() {
    if (!runnerEntries) return []
    return runnerEntries.map((e) => ({ id: e.id, runner: e.runner, origin: e.origin, destination: e.position, isBatter: e.id === 'batter' }))
  }

  function updateRunnerDestination(id, destination) {
    const originals = runnerEntriesOriginalRef.current
    if (!originals) return

    // Rebuild from the saved baseline every time. This makes a reversal undo
    // any collision-driven moves caused by that choice, while replaying the
    // user's other selections afterward so multiple edits remain independent.
    const overrides = new Map(runnerOverridesRef.current)
    overrides.delete(id)
    overrides.set(id, destination)

    let nextEntries = originals.map((entry) => ({ ...entry }))
    for (const [runnerId, runnerDestination] of overrides) {
      nextEntries = applyManualRunnerDestination(nextEntries, runnerId, runnerDestination)
    }

    const matchesOriginals = nextEntries.every((entry) => entry.position === entry.originalPosition)
    runnerOverridesRef.current = matchesOriginals ? new Map() : overrides
    const matchesSavedPlay = matchesOriginals
      && currentPa
      && currentPa.result === draft.result
      && String(currentPa.character_id) === String(draftBatter?.characterId)
    shouldSyncOutcomeRef.current = !matchesSavedPlay
    if (matchesSavedPlay) {
      // Restoring every runner also restores the PA's saved aggregate flags.
      // Treat the resulting outcome as a fresh settle so the legacy default
      // projection cannot immediately mark the form dirty again.
      setDraft((current) => ({
        ...current,
        rbi: currentPa.rbi || 0,
        run_scored: Boolean(currentPa.run_scored),
      }))
    }
    setRunnerEntries(nextEntries)
  }

  function handleBatterScoredChange(checked) {
    const batterEntry = runnerEntries?.find((entry) => entry.id === 'batter')
    if (batterEntry) {
      const resultDestination = { '1B': 'first', '2B': 'second', '3B': 'third' }[draft.result] || 'out'
      const destination = checked ? 'home' : resultDestination
      if (batterEntry.position !== destination) updateRunnerDestination('batter', destination)
    }
    setDraft((current) => ({ ...current, run_scored: checked }))
  }

  function selectResult(value) {
    const restoringSavedResult = Boolean(
      currentPa
      && value === currentPa.result
      && String(draftBatter?.characterId) === String(currentPa.character_id),
    )
    shouldSyncOutcomeRef.current = !restoringSavedResult
    setDraft((current) => ({
      ...current,
      result: value,
      ...(restoringSavedResult ? {
        rbi: currentPa.rbi || 0,
        run_scored: Boolean(currentPa.run_scored),
      } : {}),
    }))
  }

  function clearResult() {
    shouldSyncOutcomeRef.current = false
    setDraft((current) => ({ ...current, result: '' }))
  }

  function selectBatter(entry) {
    const restoringSavedBatter = Boolean(
      currentPa
      && entry
      && String(entry.character_id) === String(currentPa.character_id)
      && draft.result === currentPa.result,
    )
    shouldSyncOutcomeRef.current = !restoringSavedBatter
    setDraftBatter(entry ? { characterId: entry.character_id, playerId: entry.player_id } : null)
    if (restoringSavedBatter) {
      setDraft((current) => ({
        ...current,
        rbi: currentPa.rbi || 0,
        run_scored: Boolean(currentPa.run_scored),
      }))
    }
  }

  function resolveOutcome() {
    const result = draft.result
    const batterRunner = draftBatter ? { characterId: draftBatter.characterId, playerId: draftBatter.playerId } : null
    if (!result || !batterRunner || !derived) return null
    if (CLEARS_BASES.has(result)) {
      const occupied = ['first', 'second', 'third'].filter((b) => derived.runnersBefore[b])
      return {
        finalResult: result,
        outsOnPlay: result === 'TP' ? 3 : 0,
        rbi: result === 'TP' ? 0 : occupied.length + 1,
        runScored: result !== 'TP',
        scoredRunnerIds: result === 'TP' ? [] : [...occupied, 'batter'],
        nextRunners: { first: null, second: null, third: null },
      }
    }
    if (HOLDS_RUNNERS.has(result)) {
      return {
        finalResult: result, outsOnPlay: 1, rbi: 0, runScored: false,
        scoredRunnerIds: [], nextRunners: derived.runnersBefore,
      }
    }
    if (NEEDS_PANEL.has(result) && runnerEntries) {
      const assignments = currentAssignments()
      const pending = { assignments, outResolution: OUT_LIKE.has(result), originalResult: result }
      const finalResult = OUT_LIKE.has(result) ? derivePendingResult(pending) : result
      return {
        finalResult,
        outsOnPlay: getOutAssignments({ assignments }).length,
        rbi: getPreviewRbiFromAssignments(finalResult, assignments),
        runScored: didBatterScore(assignments),
        scoredRunnerIds: assignments.filter((a) => a.destination === 'home').map((a) => a.id),
        nextRunners: extractNextRunners({ assignments }),
      }
    }
    if (HIT_LIKE.has(result)) {
      // BB/HBP/ROE — forced advances only, no manual panel.
      const pending = computePendingState(result, derived.runnersBefore, batterRunner)
      return {
        finalResult: result,
        outsOnPlay: 0,
        rbi: getPreviewRbiFromAssignments(result, pending.assignments),
        runScored: didBatterScore(pending.assignments),
        scoredRunnerIds: pending.assignments.filter((a) => a.destination === 'home').map((a) => a.id),
        nextRunners: extractNextRunners(pending),
      }
    }
    return null
  }

  const outcome = useMemo(resolveOutcome, [draft.result, runnerEntries, draftBatter, derived])

  // rbi/run_scored default to whatever the runner panel just computed, but
  // stay independently editable below (an escape hatch for cases the
  // runner-assignment engine can't model, e.g. imported data) — only auto-
  // synced while the user hasn't touched them for this outcome yet.
  // Skips the very first *non-null* outcome computed after a page/currentPa
  // change — the runner panel takes an extra render to populate after the
  // seed effect, so outcome briefly reads null before settling; only that
  // settled value reflects the just-loaded draft (already seeded from the
  // saved rbi/run_scored) and must NOT be treated as a user edit. Any
  // outcome after that first settle (a real result/runner change) applies.
  useEffect(() => {
    if (!outcome || !shouldSyncOutcomeRef.current) return
    setDraft((d) => (d.rbi === outcome.rbi && d.run_scored === outcome.runScored ? d : { ...d, rbi: outcome.rbi, run_scored: outcome.runScored }))
  }, [outcome])

  const isBattedBall = draft.result ? battedBallResults.has(draft.result) : false
  const showFieldedMap = shouldShowFieldedLocation(draft)

  // ── Dirty tracking / unsaved-changes guard ─────────────────────────────
  // For an existing PA, dirty means the draft (including batter/pitcher/
  // pitches) diverges from the saved row. A not-yet-created page has nothing
  // saved to diverge from — it only counts as dirty once the user has
  // actually started entering something (a result, or a queued pitch).
  const dirtyFields = (() => {
    if (loading || !snapshotMatchesTarget || !derived) return []
    if (!currentPa) return [
      ...(draft.result ? ['result'] : []),
      ...(draftPitches.length ? ['pitches'] : []),
    ]

    const saved = draftFromPa(currentPa)
    return [
      ...DIRTY_CHECK_FIELDS.filter((field) => draft[field] !== saved[field]),
      ...(String(draftBatter?.characterId ?? '') !== String(currentPa.character_id ?? '') ? ['batter'] : []),
      ...(String(draftPitcher?.characterId ?? '') !== String(currentPa.pitcher_id ?? '') ? ['pitcher'] : []),
      ...(JSON.stringify(draftPitches) !== JSON.stringify(pitchesByPaId[String(currentPa.id)] || []) ? ['pitches'] : []),
      ...(runnerEntriesSnapshot(runnerEntries) !== (runnerEntriesBaselineRef.current ?? runnerEntriesSnapshot(null)) ? ['runners'] : []),
    ]
  })()
  const isDirty = dirtyFields.length > 0

  const { run: runPageChange, blocker: localBlocker } = useConfirmedAction(isDirty)

  // Reports dirty state up to an embedding host (Scorebook's own leave-page
  // guard). Standalone routes instead mount AtBatEditorRouteGuard below.
  useEffect(() => { onDirtyChange?.(isDirty) }, [isDirty, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])

  function discardDraft() {
    // Treat the restored snapshot like a fresh page load so the outcome-sync
    // effect does not immediately overwrite legacy saved RBI/run flags with
    // the default runner projection.
    shouldSyncOutcomeRef.current = false
    if (currentPa) {
      setDraft(draftFromPa(currentPa))
      setDraftBatter({ characterId: currentPa.character_id, playerId: currentPa.player_id })
      setDraftPitcher({ characterId: currentPa.pitcher_id, playerId: currentPa.pitcher_player_id })
      setDraftPitches(pitchesByPaId[String(currentPa.id)] || [])
      const batterRunner = { characterId: currentPa.character_id, playerId: currentPa.player_id }
      const pending = NEEDS_PANEL.has(currentPa.result)
        ? (HIT_LIKE.has(currentPa.result)
            ? computePendingState(currentPa.result, derived.runnersBefore, batterRunner)
            : computePendingOutState(currentPa.result, derived.runnersBefore, batterRunner))
        : null
      const defaults = pending ? buildRunnerEntriesFromAssignments(pending, derived.runnersBefore) : null
      const restored = defaults
        ? markOriginalRunnerPositions(hydrateRunnerEntries(defaults, currentPa.runner_assignments))
        : null
      runnerEntriesBaselineRef.current = runnerEntriesSnapshot(restored)
      runnerEntriesOriginalRef.current = restored
      runnerOverridesRef.current = new Map()
      setRunnerEntries(restored)
    } else {
      setDraft(emptyDraft())
      setDraftPitches([])
      runnerEntriesBaselineRef.current = null
      runnerEntriesOriginalRef.current = null
      runnerOverridesRef.current = new Map()
      setRunnerEntries(null)
    }
  }

  function writableSnapshot(action) {
    const currentResolved = resolvedTargetRef.current
    const paMatches = !currentPa || String(currentPa.game_id) === String(loadedSnapshot?.gameId)
    const rowsMatch = pas.every((pa) => String(pa.game_id) === String(loadedSnapshot?.gameId))
    const correctionMatches = !resolvingPlay || (
      String(resolvingPlay.game_id) === String(loadedSnapshot?.gameId)
      && (!resolvingPlay.competition_type || resolvingPlay.competition_type === loadedSnapshot?.source)
    )
    const valid = snapshotMatchesTarget
      && loadedSnapshot === loadedSnapshotRef.current
      && targetIsCurrent(loadedSnapshot)
      && !activeLoadRef.current
      && !loading
      && !loadError
      && game
      && String(game.id) === String(loadedSnapshot.gameId)
      && currentResolved?.targetKey === loadedSnapshot.targetKey
      && currentResolved.source === loadedSnapshot.source
      && String(currentResolved.gameId) === String(loadedSnapshot.gameId)
      && paMatches
      && rowsMatch
      && correctionMatches

    if (!valid) {
      pushToast({
        title: `${action} unavailable`,
        message: 'Wait for the selected game to finish loading, then try again.',
        type: 'error',
      })
      return null
    }
    return loadedSnapshot
  }

  useImperativeHandle(ref, () => ({
    save: () => saveAtBat(),
    discard: () => discardDraft(),
  }))

  async function saveAtBat() {
    const writeIdentity = writableSnapshot('Save')
    if (!writeIdentity || savingRef.current) return
    if (!draft.result || !draftBatter?.characterId || !outcome) {
      pushToast({ title: 'Pick a batter and a result first', type: 'error' })
      return
    }
    savingRef.current = true
    setSaving(true)
    try {
      const overrides = {
        game_id: resolvedGameId,
        player_id: draftBatter.playerId, character_id: draftBatter.characterId,
        pitcher_id: draftPitcher?.characterId ?? null, pitcher_player_id: draftPitcher?.playerId ?? null,
        inning: derived.inning, pa_number: currentPa ? currentPa.pa_number : nextPaNumber(pas),
        result: outcome.finalResult,
        outs_on_play: outcome.outsOnPlay,
        rbi: draft.rbi,
        run_scored: HOMER_RESULTS.has(outcome.finalResult) ? true : draft.run_scored,
        runner_on_first_before: Boolean(derived.runnersBefore.first),
        runner_on_second_before: Boolean(derived.runnersBefore.second),
        runner_on_third_before: Boolean(derived.runnersBefore.third),
        runner_assignments: runnerAssignmentsForSave({
          assignments: runnerEntries ? currentAssignments() : null,
          result: outcome.finalResult,
          runners: derived.runnersBefore,
          batter: draftBatter,
        }),
        trajectory: draft.trajectory, hit_x: draft.hit_x, hit_y: draft.hit_y,
        hit_distance_ft: draft.hit_distance_ft, hit_angle_deg: draft.hit_angle_deg,
        hit_stadium_key: resolvedStadiumKey,
        fielded_x: draft.fielded_x, fielded_y: draft.fielded_y,
        exit_velocity_mph: draft.exit_velocity_mph, launch_angle_deg: draft.launch_angle_deg,
        hang_time_sec: draft.hang_time_sec,
        contact_video_sec: draft.contact_video_sec, landed_video_sec: draft.landed_video_sec, fielded_video_sec: draft.fielded_video_sec,
        video_timestamp_start_sec: draft.video_timestamp_start_sec, video_timestamp_end_sec: draft.video_timestamp_end_sec,
        star_hit_used: draft.star_hit_used, is_official_ab: draft.is_official_ab,
        fielder_choice_out: draft.fielder_choice_out,
        is_buddy_jump: draft.is_buddy_jump,
        buddy_jump_assist_position: draft.is_buddy_jump ? draft.buddy_jump_assist_position : null,
        buddy_jump_putout_position: draft.is_buddy_jump ? draft.buddy_jump_putout_position : null,
        is_robbed_hr: draft.is_robbed_hr,
        strikeout_type: outcome.finalResult === 'K' ? draft.strikeout_type : null,
        is_error: draft.is_error, error_position: draft.is_error ? draft.error_position : null,
        ...(draft.is_buddy_jump && draft.trajectory ? {
          hit_notation: assembleNotation(draft.trajectory, [draft.buddy_jump_assist_position, draft.buddy_jump_putout_position].filter(Boolean)),
        } : {}),
      }
      // Spread the existing row first so any column neither this UI nor any
      // prior editor exposes (legacy passthrough fields like hit_location)
      // survives a save untouched, instead of getting silently nulled out by
      // a hand-picked whitelist payload.
      const payload = currentPa ? { ...currentPa, ...overrides } : overrides
      if (currentPa) { delete payload.id; delete payload.created_at }

      // ANSWERING A PLAY THE TRACKER COULD NOT SCORE IS ONE TRANSACTION.
      //
      // The correction, its pitches, its runs and the closing of the gap all
      // land together, at the chronological slot the play belongs in. It used
      // to be four client writes in a deliberate order, so that a failure left
      // the gap visible -- which it did, along with a plate appearance holding
      // the unresolved play's tracker_event_key. The unique index on that key
      // then refused every retry, so the only path that could close the gap was
      // blocked by its own first attempt. The function completes a half-written
      // attempt instead of colliding with it.
      if (resolvingPlay) {
        // pitch_number_game is a display ordinal across the whole game and is
        // not part of a pitch's identity; the loaded pitches are the whole
        // game's, so the next one can be counted without another round trip.
        const highestPitchNumberGame = Object.values(pitchesByPaId).flat()
          .reduce((highest, pitch) => Math.max(highest, Number(pitch.pitch_number_game) || 0), 0)
        const { data, error } = await recordUnresolvedPlayCorrection(supabase, {
          competitionType: source,
          unresolved: resolvingPlay,
          pa: payload,
          pitches: recountPitchSequence(draftPitches).map((pitch, index) => ({
            ...correctionPitchValues(pitch),
            game_id: resolvedGameId,
            pitch_number_game: highestPitchNumberGame + index + 1,
            ...(source === 'season' && game?.season_id != null ? { season_id: game.season_id } : {}),
          })),
          runs: correctionRunsPayload(),
          paNumber: (correctionSlot ?? pas.length) + 1,
          resolvedBy: player?.id ?? null,
          note: `Recorded in the At-Bat editor as ${outcome.finalResult}`,
        })
        if (error) throw error
        if (targetIsCurrent(writeIdentity)) setResolvingPlay(null)
        pushToast({ title: data?.retried ? 'Correction completed' : 'Correction recorded', type: 'success' })
        await recomputeGameScore()
        await recomputePitchingStintsForGame()
        const refreshed = await loadAll(writeIdentity)
        if (refreshed && targetIsCurrent(writeIdentity)) setPageIndex(Math.max(0, Number(data?.pa_number || 1) - 1))
        return
      }

      let savedPa = currentPa
      if (currentPa) {
        const { data, error } = await supabase.from(tables.pa).update(payload).eq('id', currentPa.id).select().single()
        if (error) throw error
        savedPa = data
      } else {
        const { data, error } = await supabase.from(tables.pa).insert(payload).select().single()
        if (error) throw error
        savedPa = data
      }

      await persistDraftPitches(savedPa)

      // Runs scored — for each assignment that reached home, insert a row,
      // charged to the current pitcher. This ledger always derives from the
      // runner panel's own outcome (never the hand-editable rbi/run_scored
      // fields above), so it stays internally consistent regardless of any
      // manual RBI override.
      if (outcome.scoredRunnerIds.length) {
        const stint = findActivePitcherStint()
        const scoringRunners = resolveScoringRunners(
          outcome.scoredRunnerIds,
          currentAssignments(),
          derived.runnersBefore,
          { characterId: draftBatter.characterId, playerId: draftBatter.playerId },
        )
        const runsPayload = scoringRunners.map((runner) => ({
          game_id: resolvedGameId, pa_id: savedPa.id, inning: derived.inning, half: derived.isTop ? 'top' : 'bottom',
          scoring_player_id: runner.playerId, scoring_character_id: runner.characterId,
          charged_to_pitcher_id: runner.chargedToPitcherId ?? stint?.character_id ?? draftPitcher?.characterId ?? null,
          charged_to_pitcher_player_id: runner.chargedToPitcherPlayerId ?? stint?.player_id ?? draftPitcher?.playerId ?? null,
          is_earned_run: !runner.reachedOnError,
          ...(source === 'season' && game?.season_id != null ? { season_id: game.season_id } : {}),
        }))
        if (currentPa) {
          const { error: deleteRunsError } = await supabase.from(tables.runsScored).delete().eq('pa_id', currentPa.id)
          if (deleteRunsError) throw deleteRunsError
        }
        const { error: insertRunsError } = await supabase.from(tables.runsScored).insert(runsPayload)
        if (insertRunsError) throw insertRunsError
      } else if (currentPa) {
        const { error: deleteRunsError } = await supabase.from(tables.runsScored).delete().eq('pa_id', currentPa.id)
        if (deleteRunsError) throw deleteRunsError
      }

      let baserunningError = null
      try {
        await syncRunnerOpportunities(supabase, {
          pa: savedPa,
          competitionType: source,
          outsBefore: derived.outsInHalf,
        })
      } catch (error) { baserunningError = error }
      await recomputeGameScore()
      await recomputePitchingStintsForGame()
      pushToast(baserunningError
        ? { title: 'At-bat saved; baserunning stats need a refresh', message: baserunningError.message, type: 'error' }
        : { title: currentPa ? 'At-bat updated' : 'At-bat added', type: 'success' })
      const newAtBatIndex = pas.length
      const refreshed = await loadAll(writeIdentity)
      if (refreshed && !currentPa && targetIsCurrent(writeIdentity)) setPageIndex(newAtBatIndex)
    } catch (err) {
      pushToast({ title: 'Save failed', message: err.message, type: 'error' })
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  // Open the correction page. Everything it shows -- the half-inning, the
  // runners, the outs, the batter, the pitcher and the pitches -- comes from
  // the unresolved play and from the game as it stood at that play's slot; the
  // seed effect above does the filling, keyed on resolvingPlay.id, so this only
  // has to say which play is being answered.
  function startResolvingPlay(row) {
    setResolvingPlay(row)
  }

  function cancelResolvingPlay() {
    setResolvingPlay(null)
    setPageIndex(pas.length)
  }

  async function deleteLatest() {
    const writeIdentity = writableSnapshot('Delete')
    if (!writeIdentity || savingRef.current) return
    if (!currentPa || !isLastPage) return
    if (!window.confirm(`Delete this at-bat (${nameFor(currentPa.character_id, currentPa.player_id)}, ${formatPaResultLabel(currentPa)})? This cannot be undone.`)) return
    savingRef.current = true
    setSaving(true)
    const { error } = await undoLatestPlateAppearance({ isSeasonGame: source === 'season', gameId: Number(resolvedGameId), plateAppearanceId: currentPa.id })
    if (error) {
      savingRef.current = false
      setSaving(false)
      pushToast({ title: 'Delete failed', message: error.message, type: 'error' })
      return
    }
    await recomputeGameScore()
    await recomputePitchingStintsForGame()
    pushToast({ title: 'At-bat deleted', type: 'success' })
    if (targetIsCurrent(writeIdentity)) setPageIndex((i) => Math.max(0, i - 1))
    await loadAll(writeIdentity)
    savingRef.current = false
    setSaving(false)
  }

  // Debugging/testing helper — wipes every at-bat for this game so a game can be
  // quickly reset and re-tracked from scratch. Reuses the same per-PA undo RPC as
  // deleteLatest (newest-first) so score/pitching-stint recompute stays correct.
  async function deleteAllAtBats() {
    const writeIdentity = writableSnapshot('Delete all')
    if (!writeIdentity || savingRef.current) return
    if (!pas.length) return
    if (!window.confirm(`Delete all ${pas.length} at-bats for this game? This cannot be undone.`)) return
    savingRef.current = true
    setSaving(true)
    try {
      const newestFirst = [...pas].sort((a, b) => Number(b.pa_number) - Number(a.pa_number))
      for (const pa of newestFirst) {
        const { error } = await undoLatestPlateAppearance({ isSeasonGame: source === 'season', gameId: Number(resolvedGameId), plateAppearanceId: pa.id })
        if (error) throw error
      }
      await recomputeGameScore()
      await recomputePitchingStintsForGame()
      pushToast({ title: 'All at-bats deleted', type: 'success' })
      if (targetIsCurrent(writeIdentity)) setPageIndex(0)
      await loadAll(writeIdentity)
    } catch (err) {
      pushToast({ title: 'Delete all failed', message: err.message, type: 'error' })
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const currentLoadError = loadError?.targetKey === targetKey ? loadError.message : null
  if (loading || (!snapshotMatchesTarget && !currentLoadError)) {
    return <div className="page-shell"><section className="panel"><p className="muted" style={{ margin: 0 }}>Loading…</p></section></div>
  }
  if (currentLoadError) {
    return (
      <div className="page-shell">
        <section className="panel" data-testid="at-bat-load-error">
          <p style={{ marginTop: 0 }}>{currentLoadError}</p>
          <button type="button" className="ghost-button" onClick={() => setRetryTarget((attempt) => attempt + 1)}>Try again</button>
        </section>
      </div>
    )
  }
  if (!game) {
    return <div className="page-shell"><section className="panel"><p className="muted" style={{ margin: 0 }}>Game not found.</p></section></div>
  }

  const hasClipBounds = draft.video_timestamp_start_sec != null && draft.video_timestamp_end_sec != null
  const showClipCapture = !hasClipBounds || editingClipBounds
  const previousClipEndSec = pas[pageIndex - 1]?.video_timestamp_end_sec ?? null
  const clipCaptureStartSec = !hasClipBounds && previousClipEndSec != null ? previousClipEndSec : undefined
  const lastPitch = draftPitches[draftPitches.length - 1]
  const liveCount = lastPitch ? `${lastPitch.count_balls_after}-${lastPitch.count_strikes_after}` : '0-0'
  const occupiedBaseCount = ['first', 'second', 'third'].filter((base) => derived.runnersBefore[base]).length
  const savedDraft = currentPa ? draftFromPa(currentPa) : null
  const originalPitchesById = Object.fromEntries(
    (currentPa ? (pitchesByPaId[String(currentPa.id)] || []) : []).map((pitch) => [String(pitch.id), pitch]),
  )
  const originalCheckClass = (field, currentValue = draft[field]) => (
    savedDraft?.[field] === true && currentValue !== true ? ' is-original' : ''
  )

  return (
    <div
      className={`at-bat-editor-shell${embedded ? ' at-bat-editor-embedded' : ''}`}
      data-competition-source={loadedSnapshot.source}
      data-game-id={loadedSnapshot.gameId}
      data-load-request={loadedSnapshot.requestId}
    >
      {!embedded ? (
        <Link to="#" className="at-bat-back-link" onClick={(e) => { e.preventDefault(); if (window.history.length > 1) window.history.back(); else window.close() }}>
          <ArrowLeft size={16} /> Back to game
        </Link>
      ) : null}

      {unresolvedPlays.length || resolvingPlay ? (
        <section className="at-bat-unresolved-panel" aria-label="Unresolved tracker plays">
          <header className="at-bat-unresolved-header">
            <strong>
              {unresolvedPlays.length} play{unresolvedPlays.length === 1 ? '' : 's'} the tracker
              could not score
            </strong>
            <span>
              Nothing below is counted for anyone until someone with the video supplies the
              result. Nothing here is guessed to make a total match.
            </span>
          </header>
          <ul className="at-bat-unresolved-list">
            {unresolvedPlays.map((row) => (
              <li key={row.id} className={resolvingPlay?.id === row.id ? 'is-active' : ''}>
                <div className="at-bat-unresolved-copy">
                  <strong>{describeUnresolvedPlay(row)}</strong>
                  <span>{row.reason}</span>
                </div>
                {canEdit ? (
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={saving}
                    onClick={() => runPageChange(() => startResolvingPlay(row))}
                  >
                    {resolvingPlay?.id === row.id ? 'Recording…' : 'Record the result'}
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {resolvingPlay ? (
            <p className="at-bat-unresolved-active" data-testid="at-bat-correction-active">
              Recording <strong>{describeUnresolvedPlay(resolvingPlay)}</strong> as at-bat
              {' '}<strong data-testid="at-bat-correction-slot">#{(correctionSlot ?? pas.length) + 1}</strong>
              {' '}of this game, in {derived?.halfLabel} with{' '}
              {derived?.outsInHalf} out{derived?.outsInHalf === 1 ? '' : 's'}. Pick the result and
              the runners below and save; the at-bat, its pitches, its runs and the closing of
              this gap are written together, under the tracker's own key, so a replay of this
              game will not overwrite it.
              {derived && derived.matchesEvidence === false ? (
                <>
                  {' '}
                  <strong data-testid="at-bat-correction-mismatch">
                    The recorded at-bats cannot place this play in {derived.evidenceHalfLabel}
                    {' '}— the game's own out count puts this slot in {derived.halfLabel}. Check
                    the half-inning before saving.
                  </strong>
                </>
              ) : null}
              {' '}
              <button
                type="button"
                className="ghost-button"
                onClick={() => runPageChange(cancelResolvingPlay)}
              >
                Cancel
              </button>
            </p>
          ) : null}
        </section>
      ) : null}

      <header className="at-bat-editor-hero">
        <div className="at-bat-editor-title-block">
          <h1>At-Bat Editor</h1>
          <div className="at-bat-context-row">
            <span>{derived?.halfLabel}</span>
            <span>{derived?.outsInHalf} out{derived?.outsInHalf === 1 ? '' : 's'}</span>
            {currentPa ? <span className="at-bat-result-summary">{formatPaResultLabel(currentPa)}</span> : <span className="at-bat-new-badge">New</span>}
          </div>
        </div>

        <div className="at-bat-hero-matchup">
          <Field label="Batter">
            <select
              disabled={!canEdit}
              value={draftBatter?.characterId ?? ''}
              onChange={(e) => {
                const entry = derived.currentLineup.find((l) => String(l.character_id) === e.target.value)
                selectBatter(entry)
              }}
            >
              <option value="">Select batter</option>
              {derived.currentLineup.map((l) => (
                <option key={l.id} value={l.character_id}>
                  {l.batting_order}. {nameFor(l.character_id, l.player_id)}
                </option>
              ))}
            </select>
          </Field>
          <div className="at-bat-versus" aria-hidden="true">VS</div>
          <Field label="Pitcher">
            <select
              disabled={!canEdit}
              value={draftPitcher?.characterId ?? ''}
              onChange={(e) => {
                const entry = derived.defensiveLineup.find((l) => String(l.character_id) === e.target.value)
                setDraftPitcher(entry ? { characterId: entry.character_id, playerId: entry.player_id } : null)
              }}
            >
              <option value="">Select pitcher</option>
              {derived.defensiveLineup.map((l) => (
                <option key={l.id} value={l.character_id}>{nameFor(l.character_id, l.player_id)}</option>
              ))}
            </select>
          </Field>
          <div className="at-bat-base-state" title="Bases before the at-bat">
            <div className="at-bat-base-diamond" role="img" aria-label={`${occupiedBaseCount} occupied base${occupiedBaseCount === 1 ? '' : 's'}`}>
              <span className={`at-bat-base at-bat-base-second${derived.runnersBefore.second ? ' is-occupied' : ''}`} />
              <span className={`at-bat-base at-bat-base-third${derived.runnersBefore.third ? ' is-occupied' : ''}`} />
              <span className={`at-bat-base at-bat-base-first${derived.runnersBefore.first ? ' is-occupied' : ''}`} />
              <span className="at-bat-home-plate" />
            </div>
            <div className="at-bat-base-copy">
              {occupiedBaseCount === 0 ? <strong>Bases empty</strong> : (
                ['first', 'second', 'third'].map((base) => derived.runnersBefore[base] ? (
                  <strong key={base}>{BASE_LABEL[base]} · {nameFor(derived.runnersBefore[base].characterId, derived.runnersBefore[base].playerId)}</strong>
                ) : null)
              )}
            </div>
          </div>
        </div>

        <div className="at-bat-editor-navigation" aria-label="Plate appearance navigation">
          <div className="at-bat-nav-controls">
            <button type="button" aria-label="Previous at-bat" className="at-bat-icon-button" disabled={pageIndex === 0} onClick={() => runPageChange(() => setPageIndex((i) => Math.max(0, i - 1)))}>
              <ChevronLeft size={18} />
            </button>
            <div className="at-bat-nav-position">
              <strong>{isNewPage ? pas.length + 1 : pageIndex + 1}</strong>
              <span>of {pas.length + 1}</span>
            </div>
            <button type="button" aria-label="Next at-bat" className="at-bat-icon-button" disabled={pageIndex >= pas.length} onClick={() => runPageChange(() => setPageIndex((i) => Math.min(pas.length, i + 1)))}>
              <ChevronRight size={18} />
            </button>
            {canEdit && isLastPage && currentPa ? (
              <button type="button" aria-label="Delete this at-bat" className="at-bat-icon-button at-bat-delete-button" disabled={saving} onClick={deleteLatest} title="Delete this at-bat">
                <Trash2 size={16} />
              </button>
            ) : null}
            {canEdit && pas.length ? (
              <button type="button" aria-label="Remove all at-bats" className="at-bat-icon-button at-bat-reset-game-button" disabled={saving} onClick={deleteAllAtBats} title="Remove every at-bat from this game">
                <Trash2 size={14} /><span>All</span>
              </button>
            ) : null}
          </div>
          {pas.length ? (
            <div className="at-bat-progress" aria-hidden="true">
              <span style={{ width: `${Math.min(100, ((pageIndex + 1) / (pas.length + 1)) * 100)}%` }} />
            </div>
          ) : null}
        </div>
      </header>

      {!canEdit ? (
        <div className="at-bat-readonly-notice">Viewing only — scorebook access is required to make changes.</div>
      ) : null}

      <div className={`at-bat-editor-workspace${isBattedBall ? ' has-field' : ''}${videoId ? ' has-video' : ''}`}>
        <div className="at-bat-editor-main-column">
          <section className="at-bat-editor-card at-bat-pitches-card">
            <div className="at-bat-section-heading at-bat-section-heading-split">
              <div className="at-bat-section-heading-copy">
                <span className="at-bat-step">1</span>
                <div>
                  <h2>Build the pitch sequence</h2>
                </div>
              </div>
              <div className="at-bat-count-display" aria-label={`Current count ${liveCount}`}>
                <strong>{liveCount}</strong>
                <span>COUNT</span>
              </div>
            </div>

            <div className="at-bat-pitch-list">
              {draftPitches.map((pitch, index) => (
                <div key={pitch.id || index} className="at-bat-pitch-wrap">
                  {canEdit && index > 0 ? (
                    <button type="button" className="at-bat-insert-pitch" aria-label={`Insert pitch before pitch ${index + 1}`} title={`Insert pitch before pitch ${index + 1}`} onClick={() => addPitchAt(index)}>
                      <Plus size={11} />
                    </button>
                  ) : null}
                  <div className={`at-bat-pitch-row at-bat-pitch-${pitch.result || 'unset'}`}>
                    <div className="at-bat-pitch-number">
                      <span>PITCH</span>
                      <strong>{pitch.pitch_number_pa}</strong>
                    </div>
                    <div className="at-bat-pitch-body">
                      <div className="at-bat-pitch-result-line">
                        {canEdit ? (
                          <select aria-label={`Pitch ${pitch.pitch_number_pa} result`} value={pitch.result || ''} onChange={(e) => updatePitchAt(index, { result: e.target.value })}>
                            {PITCH_RESULT_OPTIONS.map((opt) => <option key={opt} value={opt}>{formatPitchResultLabel(opt)}</option>)}
                          </select>
                        ) : (
                          <strong>{pitch.result === 'in_play' ? `In Play (${formatPaResultLabel(currentPa)})` : formatPitchResultLabel(pitch.result)}</strong>
                        )}
                        <span className="at-bat-pitch-count">{pitch.count_balls_after}-{pitch.count_strikes_after}</span>
                      </div>
                      <div className="at-bat-pitch-types" aria-label={`Pitch ${pitch.pitch_number_pa} type`}>
                        {(() => {
                          const hasPitchType = Boolean(pitch.pitch_type) || Boolean(pitch.is_star_pitch)
                          const originalPitch = pitch.id != null ? originalPitchesById[String(pitch.id)] : null
                          const originalType = pitchTypeValue(originalPitch)
                          const currentType = pitchTypeValue(pitch)
                          return [...PITCH_TYPE_OPTIONS, STAR_PITCH_OPTION].map((option) => {
                            const selected = option.value === 'star' ? Boolean(pitch.is_star_pitch) : (!pitch.is_star_pitch && pitch.pitch_type === option.value)
                            const wasOriginal = originalType === option.value && currentType !== originalType
                            return (
                              <button
                                key={option.value} type="button" disabled={!canEdit}
                                aria-pressed={selected}
                                aria-label={`${option.label}${selected ? ', selected' : ''}${wasOriginal ? ', original selection' : ''}`}
                                onClick={() => handlePitchTypeSelect(pitch, index, option.value)}
                                className={`at-bat-type-chip${selected ? ' is-selected' : ''}${wasOriginal ? ' is-original' : ''}${!hasPitchType ? ' is-needed' : ''}`}
                                title={option.label}
                              >
                                {option.shortLabel}
                              </button>
                            )
                          })
                        })()}
                      </div>
                    </div>
                    {canEdit ? (
                      <div className="at-bat-pitch-actions">
                        <button type="button" aria-label={`Move pitch ${index + 1} up`} disabled={index === 0} onClick={() => movePitchAt(index, 'up')}><ArrowUp size={15} /></button>
                        <button type="button" aria-label={`Move pitch ${index + 1} down`} disabled={index === draftPitches.length - 1} onClick={() => movePitchAt(index, 'down')}><ArrowDown size={15} /></button>
                        <button type="button" aria-label={`Remove pitch ${index + 1}`} onClick={() => removePitchAt(index)}><X size={15} /></button>
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}

              {draftPitches.length === 0 ? (
                <div className="at-bat-empty-state">
                  <div className="at-bat-empty-icon">0–0</div>
                  <strong>No pitches yet</strong>
                  <span>Choose the first pitch below to start the sequence.</span>
                </div>
              ) : null}
            </div>

            {canEdit ? (
              <div className="at-bat-quick-add">
                <span className="at-bat-control-label">Add pitch</span>
                <div className="at-bat-quick-add-buttons">
                  {PITCH_QUICK_OPTIONS.map(([value, label, shortLabel]) => (
                    <button key={value} type="button" className={`at-bat-quick-pitch at-bat-quick-pitch-${value}`} aria-label={`Add ${label}`} title={`Add ${label}`} onClick={() => addPitchAt(draftPitches.length, value)}>
                      {shortLabel}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </section>

          {videoId ? (
            <section className="at-bat-editor-card at-bat-video-card">
              <div className="at-bat-section-heading at-bat-video-heading">
                <span className="at-bat-section-icon"><Video size={17} /></span>
                <div><h2>Game video</h2></div>
              </div>
              <div className="at-bat-video-content">
                <YouTubePlayer
                  key={`${currentPa?.id ?? 'new'}-${showClipCapture ? 'full' : 'clip'}-${clipCaptureStartSec ?? ''}`}
                  ref={clipPlayerRef}
                  videoId={videoId}
                  startSec={showClipCapture ? clipCaptureStartSec : draft.video_timestamp_start_sec}
                  endSec={showClipCapture ? undefined : draft.video_timestamp_end_sec}
                />
                {canEdit ? (
                  <div className="at-bat-video-controls">
                    {showClipCapture ? (
                      <div className="at-bat-inline-help">
                        {hasClipBounds ? 'Scrub to new start and end points, then mark both below.' : 'Scrub to the beginning and end of this at-bat, then mark both points.'}
                      </div>
                    ) : null}
                    <div className="at-bat-video-actions">
                      {showClipCapture ? (
                        <>
                          <button type="button" className="ghost-button" onClick={() => markClipBound('video_timestamp_start_sec')} style={markButtonStyle(draft.video_timestamp_start_sec != null)}>
                            Start{draft.video_timestamp_start_sec != null ? ` · ${Number(draft.video_timestamp_start_sec).toFixed(2)}s` : ''}
                          </button>
                          <button type="button" className="ghost-button" onClick={() => markClipBound('video_timestamp_end_sec')} style={markButtonStyle(draft.video_timestamp_end_sec != null)}>
                            End{draft.video_timestamp_end_sec != null ? ` · ${Number(draft.video_timestamp_end_sec).toFixed(2)}s` : ''}
                          </button>
                          {hasClipBounds ? <button type="button" className="ghost-button" onClick={() => setEditingClipBounds(false)} style={MARK_BUTTON_BASE_STYLE}>Done</button> : null}
                          {(draft.video_timestamp_start_sec != null || draft.video_timestamp_end_sec != null) ? <button type="button" className="ghost-button" onClick={clearClipBounds} style={MARK_BUTTON_BASE_STYLE}>Clear</button> : null}
                        </>
                      ) : (
                        <>
                          {isBattedBall ? (
                            <>
                              <button type="button" className="ghost-button" onClick={() => markHangTime('contact_video_sec')} style={markButtonStyle(draft.contact_video_sec != null)}>
                                Contact{draft.contact_video_sec != null ? ` · ${Number(draft.contact_video_sec).toFixed(3)}s` : ''}
                              </button>
                              <button type="button" className="ghost-button" onClick={() => markHangTime('landed_video_sec')} style={markButtonStyle(draft.landed_video_sec != null)}>
                                Landed{draft.landed_video_sec != null ? ` · ${Number(draft.landed_video_sec).toFixed(3)}s` : ''}
                              </button>
                              {showFieldedMap ? (
                                <button type="button" className="ghost-button" onClick={markFieldedTime} style={markButtonStyle(draft.fielded_video_sec != null)}>
                                  Fielded{draft.fielded_video_sec != null ? ` · ${Number(draft.fielded_video_sec).toFixed(3)}s` : ''}
                                </button>
                              ) : null}
                            </>
                          ) : null}
                          <button type="button" className="ghost-button" onClick={() => setEditingClipBounds(true)} style={MARK_BUTTON_BASE_STYLE}>Edit clip</button>
                        </>
                      )}
                    </div>
                    <div className="at-bat-video-time-fields">
                      <Field label="Video start">
                        <input type="text" inputMode="numeric" placeholder="10:54" value={draft.video_timestamp_start_text ?? formatSecondsAsRawInput(draft.video_timestamp_start_sec)} onChange={(e) => setDraft((d) => ({ ...d, video_timestamp_start_text: e.target.value, video_timestamp_start_sec: parseRawClockInput(e.target.value) }))} />
                      </Field>
                      <Field label="Video end">
                        <input type="text" inputMode="numeric" placeholder="11:18" value={draft.video_timestamp_end_text ?? formatSecondsAsRawInput(draft.video_timestamp_end_sec)} onChange={(e) => setDraft((d) => ({ ...d, video_timestamp_end_text: e.target.value, video_timestamp_end_sec: parseRawClockInput(e.target.value) }))} />
                      </Field>
                    </div>
                  </div>
                ) : null}
              </div>
            </section>
          ) : null}
        </div>

        <section className="at-bat-editor-card at-bat-result-card">
          <div className="at-bat-section-heading at-bat-section-heading-split">
            <div className="at-bat-section-heading-copy">
              <span className="at-bat-step">2</span>
              <div>
                <h2>Record the result</h2>
              </div>
            </div>
            {draft.result ? (
              <button type="button" className="at-bat-clear-result" disabled={!canEdit} onClick={clearResult}>
                <X size={13} /> Clear
              </button>
            ) : null}
          </div>

          <div className="at-bat-result-groups">
            {RESULT_GROUPS.map((group) => (
              <div key={group.label} className="at-bat-result-group">
                <span className="at-bat-control-label">{group.label}</span>
                <div className="at-bat-result-options">
                  {group.options.map(([value, label]) => {
                    const selected = draft.result === value
                    const wasOriginal = savedDraft?.result === value && draft.result !== savedDraft.result
                    return (
                      <button
                        key={value}
                        type="button"
                        disabled={!canEdit}
                        aria-label={`${value}: ${label}${wasOriginal ? ', original selection' : ''}`}
                        aria-pressed={selected}
                        className={`at-bat-result-option${selected ? ' is-selected' : ''}${wasOriginal ? ' is-original' : ''}`}
                        onClick={() => selectResult(value)}
                        title={label}
                      >
                        <strong>{value}</strong>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>

          {!draft.result ? (
            <div className="at-bat-result-prompt">Select the play result to continue.</div>
          ) : (
            <div className="at-bat-result-details">
              {!isBattedBall ? (
                <div className="at-bat-detail-grid">
                  <Field label="RBI">
                    <input disabled={!canEdit} type="number" step="1" min="0" value={draft.rbi ?? 0} onChange={(e) => setDraft((d) => ({ ...d, rbi: e.target.value === '' ? 0 : Number(e.target.value) }))} />
                  </Field>
                  {draft.result === 'K' ? (
                    <Field label="Strikeout type">
                      <select disabled={!canEdit} value={draft.strikeout_type || ''} onChange={(e) => setDraft((d) => ({ ...d, strikeout_type: e.target.value || null }))}>
                        <option value="">Select type</option>
                        {STRIKEOUT_TYPE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                      </select>
                    </Field>
                  ) : null}
                </div>
              ) : null}

              {isBattedBall ? (
                <div className="at-bat-batted-ball-details">
                  <div className="at-bat-control-label">Batted ball details</div>
                  <div className="at-bat-trajectory-options">
                    {TRAJECTORY_OPTIONS.map((opt) => {
                      const label = { G: 'Ground', L: 'Line', F: 'Fly', B: 'Bunt' }[opt]
                      const selected = draft.trajectory === opt
                      const wasOriginal = savedDraft?.trajectory === opt && draft.trajectory !== savedDraft.trajectory
                      return (
                        <button key={opt} type="button" disabled={!canEdit} aria-label={`${label}${wasOriginal ? ', original selection' : ''}`} title={label} aria-pressed={selected} className={`${selected ? 'is-selected' : ''}${wasOriginal ? ' is-original' : ''}`.trim()} onClick={() => recomputeShotShape({ trajectory: selected ? null : opt })}>
                          <strong>{opt}</strong><span className="at-bat-trajectory-label">{label}</span>
                        </button>
                      )
                    })}
                  </div>
                  <div className="at-bat-metrics-grid">
                    <Field label="RBI"><input disabled={!canEdit} type="number" step="1" min="0" value={draft.rbi ?? 0} onChange={(e) => setDraft((d) => ({ ...d, rbi: e.target.value === '' ? 0 : Number(e.target.value) }))} /></Field>
                    <Field label="Exit velocity"><div className="at-bat-input-unit"><input disabled={!canEdit} type="number" step="0.1" value={draft.exit_velocity_mph ?? ''} onChange={(e) => setDraft((d) => ({ ...d, exit_velocity_mph: e.target.value === '' ? null : Number(e.target.value) }))} /><span>mph</span></div></Field>
                    <Field label="Launch angle"><div className="at-bat-input-unit"><input disabled={!canEdit} type="number" step="0.1" value={draft.launch_angle_deg ?? ''} onChange={(e) => setDraft((d) => ({ ...d, launch_angle_deg: e.target.value === '' ? null : Number(e.target.value) }))} /><span>deg</span></div></Field>
                    <Field label="Hit distance"><div className="at-bat-input-unit"><input disabled={!canEdit} type="number" step="1" value={draft.hit_distance_ft ?? ''} onChange={(e) => recomputeShotShape({ hit_distance_ft: e.target.value === '' ? null : Number(e.target.value) })} /><span>ft</span></div></Field>
                    <Field label="Hang time"><div className="at-bat-input-unit"><input disabled={!canEdit} type="number" step="0.001" value={draft.hang_time_sec ?? ''} onChange={(e) => recomputeShotShape({ hang_time_sec: e.target.value === '' ? null : Number(e.target.value) })} /><span>sec</span></div></Field>
                  </div>
                  {draft.trajectory && draft.trajectory !== 'G' ? (
                    <button
                      type="button" className={`at-bat-special-toggle${draft.is_robbed_hr ? ' is-selected' : ''}${originalCheckClass('is_robbed_hr')}`} disabled={!canEdit}
                      onClick={() => setDraft((d) => ({ ...d, is_robbed_hr: !d.is_robbed_hr }))}
                      title={draft.is_robbed_hr ? 'Marked as a robbed home run.' : autoRobbedHr ? 'This catch may have robbed a home run.' : 'Mark this catch as a robbed home run.'}
                    >
                      {draft.is_robbed_hr ? 'Robbed home run' : autoRobbedHr ? 'Possible HR robbery' : 'Mark HR robbery'}
                    </button>
                  ) : null}
                </div>
              ) : null}

              <details className="at-bat-advanced-details" defaultOpen={Boolean(draft.is_error || draft.is_buddy_jump)}>
                <summary>Scoring flags</summary>
                <div className="at-bat-toggle-grid">
                  <label className={`at-bat-check-tile${originalCheckClass('run_scored', draft.run_scored)}`} title={HOMER_RESULTS.has(draft.result) ? 'A home run always scores the batter.' : undefined}>
                    <input
                      disabled={!canEdit}
                      type="checkbox"
                      checked={draft.run_scored}
                      aria-readonly={HOMER_RESULTS.has(draft.result)}
                      onChange={(e) => {
                        // Keep the control visibly checked (and green) for a
                        // homer without using disabled browser styling. A
                        // corrupt imported HR with this flag off can still be
                        // repaired by checking it; only unchecking a valid HR
                        // is ignored because that state is impossible.
                        if (HOMER_RESULTS.has(draft.result) && !e.target.checked) return
                        handleBatterScoredChange(e.target.checked)
                      }}
                    />
                    <span>Batter scored</span>
                  </label>
                  <label className={`at-bat-check-tile${originalCheckClass('star_hit_used')}`}><input disabled={!canEdit} type="checkbox" checked={draft.star_hit_used} onChange={(e) => setDraft((d) => ({ ...d, star_hit_used: e.target.checked }))} /><span>Star hit used</span></label>
                  <label className={`at-bat-check-tile${originalCheckClass('is_official_ab')}`}><input disabled={!canEdit} type="checkbox" checked={draft.is_official_ab} onChange={(e) => setDraft((d) => ({ ...d, is_official_ab: e.target.checked }))} /><span>Official at-bat</span></label>
                  <label className={`at-bat-check-tile${originalCheckClass('fielder_choice_out')}`}><input disabled={!canEdit} type="checkbox" checked={draft.fielder_choice_out} onChange={(e) => setDraft((d) => ({ ...d, fielder_choice_out: e.target.checked }))} /><span>Fielder's choice out</span></label>
                  <label className={`at-bat-check-tile${originalCheckClass('is_error')}`}><input disabled={!canEdit} type="checkbox" checked={draft.is_error} onChange={(e) => setDraft((d) => ({ ...d, is_error: e.target.checked }))} /><span>Error on play</span></label>
                  <label className={`at-bat-check-tile${originalCheckClass('is_buddy_jump')}`}><input disabled={!canEdit} type="checkbox" checked={draft.is_buddy_jump} onChange={(e) => setDraft((d) => ({ ...d, is_buddy_jump: e.target.checked }))} /><span>Buddy jump</span></label>
                </div>
                {draft.is_error ? (
                  <Field label="Error charged to">
                    <select disabled={!canEdit} value={draft.error_position ?? ''} onChange={(e) => setDraft((d) => ({ ...d, error_position: e.target.value === '' ? null : Number(e.target.value) }))}>
                      <option value="">Select position</option>
                      {FIELD_POSITIONS.map((p) => <option key={p.position} value={p.position}>{p.label}</option>)}
                    </select>
                  </Field>
                ) : null}
                {draft.is_buddy_jump ? (
                  <div className="at-bat-detail-grid">
                    <Field label="Buddy jump assist">
                      <select disabled={!canEdit} value={draft.buddy_jump_assist_position ?? ''} onChange={(e) => setDraft((d) => ({ ...d, buddy_jump_assist_position: e.target.value === '' ? null : Number(e.target.value) }))}>
                        <option value="">Select position</option>
                        {FIELD_POSITIONS.map((p) => <option key={p.position} value={p.position}>{p.label}</option>)}
                      </select>
                    </Field>
                    <Field label="Buddy jump putout">
                      <select disabled={!canEdit} value={draft.buddy_jump_putout_position ?? ''} onChange={(e) => setDraft((d) => ({ ...d, buddy_jump_putout_position: e.target.value === '' ? null : Number(e.target.value) }))}>
                        <option value="">Select position</option>
                        {FIELD_POSITIONS.map((p) => <option key={p.position} value={p.position}>{p.label}</option>)}
                      </select>
                    </Field>
                  </div>
                ) : null}
              </details>

              {runnerEntries ? (
                <div className="at-bat-runner-panel">
                  {runnerEntries.map((entry) => (
                    <div key={entry.id} className="at-bat-runner-row">
                      <span><strong>{entry.id === 'batter' ? 'Batter' : `Runner on ${BASE_LABEL[entry.origin]}`}</strong>{nameFor(entry.runner.characterId, entry.runner.playerId)}</span>
                      <div className={`at-bat-runner-destination${entry.originalPosition && entry.position !== entry.originalPosition ? ' is-changed' : ''}`}>
                        {entry.originalPosition && entry.position !== entry.originalPosition ? (
                          <span className="at-bat-runner-original" aria-label={`Original destination: ${BASE_LABEL[entry.originalPosition]}`}>
                            {BASE_LABEL[entry.originalPosition]} →
                          </span>
                        ) : null}
                        <select disabled={!canEdit} value={entry.position} onChange={(e) => updateRunnerDestination(entry.id, e.target.value)}>
                          {['first', 'second', 'third', 'home', 'out'].map((base) => <option key={base} value={base}>{BASE_LABEL[base]}</option>)}
                        </select>
                      </div>
                    </div>
                  ))}
                  {outcome ? <div className="at-bat-outcome-summary"><strong>{outcome.finalResult}</strong><span>{outcome.outsOnPlay} out{outcome.outsOnPlay === 1 ? '' : 's'}</span><span>{draft.rbi} RBI</span></div> : null}
                </div>
              ) : outcome ? (
                <div className="at-bat-outcome-summary"><strong>{outcome.finalResult}</strong><span>{outcome.outsOnPlay} out{outcome.outsOnPlay === 1 ? '' : 's'}</span><span>{draft.rbi} RBI</span>{draft.run_scored ? <span>Batter scores</span> : null}</div>
              ) : null}
            </div>
          )}

          {canEdit ? (
            <div className="at-bat-save-bar">
              <div>
                <strong>{isDirty ? 'Unsaved changes' : 'Saved'}</strong>
                <span>{draft.result ? `${draft.result} · ${draftPitches.length} pitch${draftPitches.length === 1 ? '' : 'es'}` : 'Choose a result'}</span>
              </div>
              <div className="at-bat-save-actions">
                <button type="button" className="at-bat-reset-button" onClick={discardDraft} disabled={saving || !isDirty}><RotateCcw size={15} /> Reset</button>
                <button type="button" className="at-bat-save-button" onClick={saveAtBat} disabled={saving || !draft.result || !draftBatter?.characterId}>
                  <Save size={16} /> {saving ? 'Saving…' : currentPa ? 'Save changes' : 'Save at-bat'}
                </button>
              </div>
            </div>
          ) : null}
        </section>

        {isBattedBall ? (
          <section className="at-bat-editor-card at-bat-field-card">
            <div className="at-bat-section-heading">
              <span className="at-bat-step">3</span>
              <div><h2>Place the ball</h2></div>
            </div>
            <FieldPlayBuilder
              landingSpot={draft.hit_x != null && draft.hit_y != null ? { x: draft.hit_x, y: draft.hit_y } : null}
              onFieldTap={canEdit ? handleFieldTap : undefined}
              secondarySpot={showFieldedMap && draft.fielded_x != null && draft.fielded_y != null ? { x: draft.fielded_x, y: draft.fielded_y } : null}
              onSecondaryTap={canEdit && showFieldedMap ? handleFieldedTap : undefined}
              fieldersByPosition={activeDefensiveFielders}
              allowFielderSelection={false}
              label={null}
              stadiumKey={resolvedStadiumKey}
            />
          </section>
        ) : null}
      </div>

      <UnsavedChangesPrompt
        blocker={localBlocker}
        onSave={() => saveAtBat()}
        message="You have unsaved changes to this at-bat. Save them before moving on, or discard them?"
      />
      {!embedded ? (
        <AtBatEditorRouteGuard
          isDirty={isDirty}
          onSave={() => saveAtBat()}
        />
      ) : null}
    </div>
  )
})

export default AtBatEditor
