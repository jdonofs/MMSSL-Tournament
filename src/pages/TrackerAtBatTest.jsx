import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Copy, RefreshCw } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { fetchAllRows } from '../utils/fetchAllRows'
import FieldPlayBuilder, { STADIUM_CONFIGS } from '../components/FieldPlayBuilder'
import { shouldShowFieldedLocation } from '../utils/fieldedLocation'
import { battedBallResults } from '../utils/statsCalculator'
import { formatPaResultLabel, formatPitchResultLabel, formatResultName } from '../utils/notation'
import { getStadiumKeyByName, getStadiumNameByKey } from '../utils/stadiums'

// This is a TEMPORARY, READ-ONLY diagnostic page for verifying that the
// tracker bridge (scripts/live_tracker_bridge.mjs) wrote every field the
// At-Bat Editor (src/pages/AtBatEditor.jsx) relies on. It never writes to
// the database — it only reads and displays. Delete this page (and its
// route in App.jsx) once tracker output has been verified.
//
// This is an at-bat-by-at-bat tool, not a "look up a game" tool — there is
// no game id to plug in. It auto-detects whichever game is currently in
// Tracker mode, the exact same way scripts/live_tracker_bridge.mjs itself
// picks its target (stats_source='tracker' + an open status), and rides
// that game's PAs live. A ?source=&gameId= query string still works as an
// escape hatch to inspect a specific game after tracking has stopped.

const TABLES = {
  tournament: {
    pa: 'plate_appearances', pitches: 'pitches', games: 'games',
    runsScored: 'runs_scored', trackerLiveStats: 'tracker_live_stats',
    openStatuses: ['pending', 'active'],
  },
  season: {
    pa: 'season_plate_appearances', pitches: 'season_pitches', games: 'season_schedule',
    runsScored: 'season_runs_scored', trackerLiveStats: 'season_tracker_live_stats',
    openStatuses: ['scheduled', 'in_progress'],
  },
}

// Same "does this PA need a runner-resolution panel" set the At-Bat Editor
// uses (AtBatEditor.jsx's NEEDS_PANEL) — reused here only to judge whether a
// missing runner_assignments value is expected-but-absent (NEEDS RESEARCH)
// vs. simply not applicable to a forced-advance-only result.
const COMPLEX_RUNNER_RESULTS = new Set(['1B', '2B', '3B', 'GO', 'FO', 'LO', 'SF', 'SH', 'DP', 'FC'])
const OUT_LIKE_RESULTS = new Set(['GO', 'FO', 'LO', 'SF', 'SH', 'DP', 'FC'])
const FLY_OR_LINE_RESULTS = new Set(['FO', 'LO'])
const MANUAL_VIDEO_FIELDS = new Set([
  'contact_video_sec', 'landed_video_sec', 'fielded_video_sec',
  'video_timestamp_start_sec', 'video_timestamp_end_sec',
])

// ── Status badge classification ──────────────────────────────────────────
// CAPTURED / MANUAL_EXTERNAL / NOT_APPLICABLE / NEEDS_RESEARCH / MISSING
const STATUS = {
  CAPTURED: { label: 'CAPTURED', color: '#4ade80' },
  MANUAL_EXTERNAL: { label: 'MANUAL / EXTERNAL', color: '#38bdf8' },
  NOT_APPLICABLE: { label: 'NOT APPLICABLE', color: '#64748b' },
  NEEDS_RESEARCH: { label: 'NEEDS RESEARCH', color: '#eab308' },
  MISSING: { label: 'MISSING EXPECTED DATA', color: '#fb7185' },
}

function isPresent(v) {
  return v !== null && v !== undefined
}

// Per-field classification for a plate-appearance row. Kept as one function
// (rather than scattering rules across the render) so the acceptance
// criteria's "explicit field metadata, not null==failure" rule lives in a
// single, auditable place.
function paFieldStatus(field, pa) {
  const v = pa[field]
  const isBattedBall = battedBallResults.has(pa.result)
  const showsFielded = shouldShowFieldedLocation(pa)

  switch (field) {
    case 'id': case 'game_id': case 'pa_number': case 'inning':
    case 'player_id': case 'character_id': case 'batting_team_id': case 'defensive_team_id':
    case 'pitcher_id': case 'pitcher_player_id': case 'created_at':
    case 'result': case 'outs_on_play': case 'rbi': case 'run_scored':
    case 'is_official_ab': case 'is_earned_run': case 'is_error':
    case 'runner_on_first_before': case 'runner_on_second_before': case 'runner_on_third_before':
    case 'is_buddy_jump':
      return isPresent(v) ? STATUS.CAPTURED : STATUS.MISSING

    case 'hit_notation':
      if (!isBattedBall) return STATUS.NOT_APPLICABLE
      return isPresent(v) ? STATUS.CAPTURED : STATUS.NEEDS_RESEARCH

    case 'fielder_choice_out':
      if (pa.result !== 'FC') return STATUS.NOT_APPLICABLE
      return isPresent(v) ? STATUS.CAPTURED : STATUS.NEEDS_RESEARCH

    case 'error_position':
      if (!pa.is_error) return STATUS.NOT_APPLICABLE
      return isPresent(v) ? STATUS.CAPTURED : STATUS.MISSING

    case 'is_nice_play':
    case 'is_robbed_hr':
      return isPresent(v) ? STATUS.CAPTURED : STATUS.NEEDS_RESEARCH

    case 'trajectory':
      if (!isBattedBall) return STATUS.NOT_APPLICABLE
      if (isPresent(v)) return STATUS.CAPTURED
      return FLY_OR_LINE_RESULTS.has(pa.result) ? STATUS.NEEDS_RESEARCH : STATUS.MISSING

    case 'hit_stadium_key': case 'hit_x': case 'hit_y':
    case 'hit_distance_ft': case 'hit_angle_deg':
    case 'exit_velocity_mph': case 'launch_angle_deg': case 'hang_time_sec':
      if (!isBattedBall) return STATUS.NOT_APPLICABLE
      return isPresent(v) ? STATUS.CAPTURED : STATUS.MISSING

    case 'fielded_x': case 'fielded_y':
      if (!showsFielded) return STATUS.NOT_APPLICABLE
      return isPresent(v) ? STATUS.CAPTURED : STATUS.MISSING

    case 'star_hit_used': case 'star_pitch_used': case 'star_pitch_successful':
      return isPresent(v) ? STATUS.CAPTURED : STATUS.NEEDS_RESEARCH

    case 'strikeout_type':
      if (pa.result !== 'K') return STATUS.NOT_APPLICABLE
      return isPresent(v) ? STATUS.CAPTURED : STATUS.NEEDS_RESEARCH

    case 'buddy_jump_assist_position': case 'buddy_jump_putout_position':
      if (!pa.is_buddy_jump) return STATUS.NOT_APPLICABLE
      return isPresent(v) ? STATUS.CAPTURED : STATUS.MISSING

    case 'runner_assignments':
      if (isPresent(v)) return STATUS.CAPTURED
      return COMPLEX_RUNNER_RESULTS.has(pa.result) ? STATUS.NEEDS_RESEARCH : STATUS.NOT_APPLICABLE

    default:
      if (MANUAL_VIDEO_FIELDS.has(field)) return isPresent(v) ? STATUS.CAPTURED : STATUS.MANUAL_EXTERNAL
      return isPresent(v) ? STATUS.CAPTURED : STATUS.MISSING
  }
}

function pitchFieldStatus(field, pitch) {
  const v = pitch[field]
  if (field === 'pitch_type') {
    if (pitch.is_star_pitch) return STATUS.NOT_APPLICABLE
    return isPresent(v) ? STATUS.CAPTURED : STATUS.MANUAL_EXTERNAL
  }
  return isPresent(v) ? STATUS.CAPTURED : STATUS.MISSING
}

function Badge({ status }) {
  return (
    <span
      style={{
        display: 'inline-block', fontSize: 9, fontWeight: 800, letterSpacing: '.03em',
        padding: '2px 6px', borderRadius: 999, color: status.color,
        border: `1px solid ${status.color}55`, background: `${status.color}18`,
        whiteSpace: 'nowrap',
      }}
    >
      {status.label}
    </span>
  )
}

function formatValue(v) {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function DataRow({ label, field, value, status }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, color: 'var(--text)', fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 10, color: 'var(--muted)', fontFamily: 'monospace' }}>{field}</div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={{ fontSize: 13, fontFamily: 'monospace', color: '#e2e8f0', maxWidth: 220, overflowWrap: 'anywhere', textAlign: 'right' }}>
          {formatValue(value)}
        </span>
        <Badge status={status} />
      </div>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <section className="panel" style={{ padding: '0.9rem 1rem' }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--gold)', textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8 }}>{title}</div>
      {children}
    </section>
  )
}

function CopyableJson({ title, value }) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const text = useMemo(() => JSON.stringify(value ?? null, null, 2), [value])

  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 10px', background: 'rgba(255,255,255,0.03)' }}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          style={{ background: 'none', border: 'none', color: 'var(--text)', cursor: 'pointer', fontSize: 12, fontWeight: 700, padding: 0, display: 'flex', alignItems: 'center', gap: 6 }}
        >
          {open ? '▾' : '▸'} {title}
        </button>
        <button
          type="button"
          className="ghost-button"
          style={{ fontSize: 10, padding: '3px 8px', gap: 4 }}
          onClick={async () => {
            await navigator.clipboard?.writeText(text)
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          }}
        >
          <Copy size={11} /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {open ? (
        <pre style={{ margin: 0, padding: '10px 12px', fontSize: 11, lineHeight: 1.5, overflowX: 'auto', background: 'rgba(2,6,23,0.5)', color: '#cbd5e1' }}>
          {text}
        </pre>
      ) : null}
    </div>
  )
}

// Finds whichever game(s) are currently toggled into Tracker mode, the same
// query live_tracker_bridge.mjs's resolveTargetGame() runs against
// games/season_schedule (stats_source='tracker' + an open status). Read-only
// — this never touches stats_source/status, only reads them.
async function findActiveTrackerGames() {
  const results = []
  for (const source of ['tournament', 'season']) {
    const cfg = TABLES[source]
    const { data } = await supabase
      .from(cfg.games).select('*')
      .eq('stats_source', 'tracker').in('status', cfg.openStatuses)
    for (const row of (data || [])) results.push({ source, game: row })
  }
  return results
}

export default function TrackerAtBatTest() {
  const [searchParams] = useSearchParams()
  const overrideGameId = searchParams.get('gameId')
  const overrideSource = searchParams.get('source') === 'season' ? 'season' : 'tournament'
  const hasOverride = Boolean(overrideGameId)

  const [autoCandidates, setAutoCandidates] = useState(null) // null = still resolving
  const [manualPick, setManualPick] = useState(null)

  // Re-detect whenever a game's Tracker-mode toggle or status flips, so this
  // page follows the bridge onto its next game without a manual link change.
  useEffect(() => {
    if (hasOverride) return undefined
    let cancelled = false
    function resolve() {
      findActiveTrackerGames().then((results) => { if (!cancelled) setAutoCandidates(results) })
    }
    resolve()
    const channel = supabase
      .channel(`tracker-at-bat-test-game-finder-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'games' }, resolve)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'season_schedule' }, resolve)
      .subscribe()
    return () => { cancelled = true; supabase.removeChannel(channel) }
  }, [hasOverride])

  const autoTarget = autoCandidates?.length === 1 ? autoCandidates[0] : null
  const target = hasOverride
    ? { source: overrideSource, gameId: Number(overrideGameId) }
    : (manualPick || (autoTarget ? { source: autoTarget.source, gameId: autoTarget.game.id } : null))

  const source = target?.source || 'tournament'
  const tables = TABLES[source]
  const gameId = target?.gameId ?? null
  const isAutoDetected = !hasOverride && !manualPick

  const [loading, setLoading] = useState(true)
  const [game, setGame] = useState(null)
  const [pas, setPas] = useState([])
  const [pitchesByPaId, setPitchesByPaId] = useState({})
  const [runsByPaId, setRunsByPaId] = useState({})
  const [trackerStats, setTrackerStats] = useState(null)
  const [charactersById, setCharactersById] = useState({})
  const [playersById, setPlayersById] = useState({})
  const [stadiumsById, setStadiumsById] = useState({})
  const [seasonTeamRows, setSeasonTeamRows] = useState([])
  const [pageIndex, setPageIndex] = useState(0)
  const [autoFollow, setAutoFollow] = useState(true)
  const [lastLoadedAt, setLastLoadedAt] = useState(null)

  async function loadAll({ preserveIndex = true } = {}) {
    if (!gameId) return
    const { data: gameRow } = await supabase.from(tables.games).select('*').eq('id', gameId).maybeSingle()
    const [
      { data: paRows },
      { data: characterRows },
      { data: playerRows },
      { data: stadiumRows },
      { data: seasonTeamData },
      { data: liveStatsRow },
    ] = await Promise.all([
      fetchAllRows(() => supabase.from(tables.pa).select('*').eq('game_id', gameId)),
      supabase.from('characters').select('id,name'),
      supabase.from('players').select('id,name'),
      supabase.from('stadiums').select('id,name'),
      source === 'season' && gameRow?.season_id != null
        ? supabase.from('season_teams').select('id,player_id').eq('season_id', gameRow.season_id)
        : Promise.resolve({ data: [] }),
      supabase.from(tables.trackerLiveStats).select('*').eq('game_id', gameId).maybeSingle(),
    ])

    const orderedPas = (paRows || []).slice().sort((a, b) => Number(a.pa_number) - Number(b.pa_number))
    const [{ data: pitchRows }, { data: runRows }] = await Promise.all([
      orderedPas.length
        ? fetchAllRows(() => supabase.from(tables.pitches).select('*').in('pa_id', orderedPas.map((p) => p.id)))
        : Promise.resolve({ data: [] }),
      orderedPas.length
        ? fetchAllRows(() => supabase.from(tables.runsScored).select('*').in('pa_id', orderedPas.map((p) => p.id)))
        : Promise.resolve({ data: [] }),
    ])

    const groupedPitches = {}
    for (const row of (pitchRows || [])) {
      const key = String(row.pa_id)
      if (!groupedPitches[key]) groupedPitches[key] = []
      groupedPitches[key].push(row)
    }
    Object.keys(groupedPitches).forEach((key) => {
      groupedPitches[key].sort((a, b) => Number(a.pitch_number_pa) - Number(b.pitch_number_pa))
    })

    const groupedRuns = {}
    for (const row of (runRows || [])) {
      const key = String(row.pa_id)
      if (!groupedRuns[key]) groupedRuns[key] = []
      groupedRuns[key].push(row)
    }

    setGame(gameRow || null)
    setPas(orderedPas)
    setPitchesByPaId(groupedPitches)
    setRunsByPaId(groupedRuns)
    setTrackerStats(liveStatsRow || null)
    setCharactersById(Object.fromEntries((characterRows || []).map((c) => [String(c.id), c])))
    setPlayersById(Object.fromEntries((playerRows || []).map((p) => [String(p.id), p])))
    setStadiumsById(Object.fromEntries((stadiumRows || []).map((s) => [String(s.id), s])))
    setSeasonTeamRows(seasonTeamData || [])

    setPageIndex((current) => {
      if (!orderedPas.length) return 0
      if (!preserveIndex) return orderedPas.length - 1
      // Auto-follow keeps riding the newest PA; otherwise clamp the existing
      // position (a delete/undo elsewhere in the app could shrink the list).
      return autoFollow ? orderedPas.length - 1 : Math.min(current, orderedPas.length - 1)
    })
    setLastLoadedAt(new Date())
    setLoading(false)
  }

  useEffect(() => {
    if (!gameId) return undefined
    let cancelled = false
    setLoading(true)
    loadAll({ preserveIndex: false }).catch((err) => {
      if (!cancelled) { console.error(err); setLoading(false) }
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, source])

  // Realtime: a newly finalized PA (or an edited pitch row) from the tracker
  // bridge shows up without a manual refresh. Read-only — this never writes.
  useEffect(() => {
    if (!gameId) return undefined
    const channel = supabase
      .channel(`tracker-at-bat-test-${source}-${gameId}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: tables.pa, filter: `game_id=eq.${gameId}` }, () => loadAll())
      .on('postgres_changes', { event: '*', schema: 'public', table: tables.pitches, filter: `game_id=eq.${gameId}` }, () => loadAll())
      .on('postgres_changes', { event: '*', schema: 'public', table: tables.runsScored, filter: `game_id=eq.${gameId}` }, () => loadAll())
      .on('postgres_changes', { event: '*', schema: 'public', table: tables.trackerLiveStats, filter: `game_id=eq.${gameId}` }, () => loadAll())
      .subscribe()
    return () => supabase.removeChannel(channel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, source, autoFollow])

  const playerIdBySeasonTeamId = useMemo(
    () => Object.fromEntries(seasonTeamRows.map((t) => [String(t.id), t.player_id])),
    [seasonTeamRows],
  )

  function teamName(teamId) {
    if (teamId == null) return '—'
    const playerId = source === 'season' ? playerIdBySeasonTeamId[String(teamId)] : teamId
    return playersById[String(playerId)]?.name || '—'
  }

  function characterName(id) {
    return charactersById[String(id)]?.name || '—'
  }

  function playerName(id) {
    return playersById[String(id)]?.name || '—'
  }

  function nameFor(characterId, playerId) {
    const charName = characterName(characterId)
    const pName = playerName(playerId)
    return pName !== '—' ? `${charName} (${pName})` : charName
  }

  const currentPa = pas[pageIndex] || null
  const currentPitches = currentPa ? (pitchesByPaId[String(currentPa.id)] || []) : []
  const currentRuns = currentPa ? (runsByPaId[String(currentPa.id)] || []) : []

  const gameStadiumKey = source === 'season'
    ? getStadiumKeyByName(game?.stadium)
    : (game?.stadium_id ? getStadiumKeyByName(stadiumsById[String(game.stadium_id)]?.name) : null)
  const resolvedStadiumKey = currentPa?.hit_stadium_key || gameStadiumKey
  const stadiumConfig = resolvedStadiumKey ? STADIUM_CONFIGS[resolvedStadiumKey] : null
  const stadiumDisplayName = currentPa?.hit_stadium_key
    ? (getStadiumNameByKey(currentPa.hit_stadium_key) || currentPa.hit_stadium_key)
    : null

  const isBattedBall = currentPa ? battedBallResults.has(currentPa.result) : false
  const landingSpot = currentPa && currentPa.hit_x != null && currentPa.hit_y != null
    ? { x: currentPa.hit_x, y: currentPa.hit_y } : null
  const fieldedSpot = currentPa && currentPa.fielded_x != null && currentPa.fielded_y != null
    ? { x: currentPa.fielded_x, y: currentPa.fielded_y } : null

  function goPrev() {
    setAutoFollow(false)
    setPageIndex((i) => Math.max(0, i - 1))
  }
  function goNext() {
    setPageIndex((i) => {
      const next = Math.min(pas.length - 1, i + 1)
      if (next === pas.length - 1) setAutoFollow(true)
      else setAutoFollow(false)
      return next
    })
  }

  const identitySection = currentPa ? [
    ['id', 'id'], ['game_id', 'game_id'], ['pa_number', 'pa_number'], ['inning', 'inning'],
    ['player_id', 'player_id'], ['character_id', 'character_id'],
    ['batting_team_id', 'batting_team_id'], ['defensive_team_id', 'defensive_team_id'],
    ['pitcher_id', 'pitcher_id'], ['pitcher_player_id', 'pitcher_player_id'], ['created_at', 'created_at'],
  ] : []

  const resultSection = [
    'result', 'outs_on_play', 'rbi', 'run_scored', 'is_official_ab', 'is_earned_run',
    'hit_notation', 'fielder_choice_out', 'is_error', 'error_position', 'is_nice_play',
  ]
  const battedBallSection = [
    'trajectory', 'hit_stadium_key', 'hit_x', 'hit_y', 'hit_distance_ft', 'hit_angle_deg',
    'fielded_x', 'fielded_y', 'exit_velocity_mph', 'launch_angle_deg', 'hang_time_sec',
  ]
  const specialSection = [
    'star_hit_used', 'star_pitch_used', 'star_pitch_successful', 'is_buddy_jump',
    'buddy_jump_assist_position', 'buddy_jump_putout_position', 'is_robbed_hr', 'strikeout_type',
  ]
  const runnerSection = [
    'runner_on_first_before', 'runner_on_second_before', 'runner_on_third_before', 'runner_assignments',
  ]
  const videoSection = [
    'contact_video_sec', 'landed_video_sec', 'fielded_video_sec',
    'video_timestamp_start_sec', 'video_timestamp_end_sec',
  ]

  const prominentPitchFields = [
    'id', 'pa_id', 'pitch_number_pa', 'pitch_number_game', 'result', 'pitch_type', 'is_star_pitch',
    'count_balls_before', 'count_strikes_before', 'count_balls_after', 'count_strikes_after',
    'pitcher_id', 'batter_id', 'inning', 'half',
  ]

  // Still detecting which game (if any) is in Tracker mode.
  if (!hasOverride && autoCandidates === null) {
    return (
      <div className="page-shell">
        <section className="panel"><p className="muted" style={{ margin: 0 }}>Detecting the active tracker game…</p></section>
      </div>
    )
  }

  // No game is toggled into Tracker mode right now — nothing to follow yet.
  if (!hasOverride && !manualPick && autoCandidates.length === 0) {
    return (
      <div className="page-shell">
        <section className="panel">
          <p className="muted" style={{ margin: 0 }}>
            Waiting for the tracker to complete an at-bat. A plate appearance appears after the bridge finalizes it.
          </p>
          <p className="muted" style={{ margin: '8px 0 0', fontSize: 12 }}>
            No game is currently set to Tracker mode — toggle a game into Tracker mode on the site, or start the bridge, and this page will pick it up automatically.
          </p>
        </section>
      </div>
    )
  }

  // More than one game is simultaneously in Tracker mode — ambiguous, ask which one.
  if (!hasOverride && !manualPick && autoCandidates.length > 1) {
    return (
      <div className="page-shell">
        <section className="panel">
          <p className="muted" style={{ margin: '0 0 10px' }}>
            Multiple games are in Tracker mode at once — pick one to view:
          </p>
          <div style={{ display: 'grid', gap: 8 }}>
            {autoCandidates.map(({ source: s, game: g }) => (
              <button
                key={`${s}-${g.id}`}
                type="button"
                className="ghost-button"
                style={{ justifyContent: 'flex-start' }}
                onClick={() => setManualPick({ source: s, gameId: g.id })}
              >
                {s === 'season' ? 'Season' : 'Tournament'} game #{g.id}
              </button>
            ))}
          </div>
        </section>
      </div>
    )
  }

  if (loading) {
    return <div className="page-shell"><section className="panel"><p className="muted" style={{ margin: 0 }}>Loading…</p></section></div>
  }
  if (!game) {
    return <div className="page-shell"><section className="panel"><p className="muted" style={{ margin: 0 }}>Game not found.</p></section></div>
  }

  return (
    <div className="page-shell" style={{ display: 'grid', gap: 14 }}>
      <div className="at-bat-readonly-notice" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <span>
          Read-only tracker QA view — {source === 'season' ? 'Season' : 'Tournament'} game #{gameId}
          {isAutoDetected ? ' (auto-detected from Tracker mode)' : ''}. This page never writes to the database.
        </span>
        <span style={{ fontSize: 11, color: 'var(--muted)' }}>
          {lastLoadedAt ? `Last synced ${lastLoadedAt.toLocaleTimeString()}` : null}
        </span>
      </div>

      {!pas.length ? (
        <section className="panel">
          <p className="muted" style={{ margin: 0 }}>
            Waiting for the tracker to complete an at-bat. A plate appearance appears after the bridge finalizes it.
          </p>
        </section>
      ) : (
        <>
          {/* Navigation + auto-follow */}
          <section className="panel" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button type="button" className="ghost-button" aria-label="Previous plate appearance" disabled={pageIndex === 0} onClick={goPrev}>
                <ChevronLeft size={16} /> Prev
              </button>
              <div style={{ fontSize: 13, fontWeight: 700 }}>
                PA {pageIndex + 1} of {pas.length} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(pa_number {currentPa?.pa_number})</span>
              </div>
              <button type="button" className="ghost-button" aria-label="Next plate appearance" disabled={pageIndex >= pas.length - 1} onClick={goNext}>
                Next <ChevronRight size={16} />
              </button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700 }}>
                <input
                  type="checkbox"
                  checked={autoFollow}
                  onChange={(e) => {
                    const checked = e.target.checked
                    setAutoFollow(checked)
                    if (checked) setPageIndex(pas.length - 1)
                  }}
                />
                Auto-follow latest PA
              </label>
              <button type="button" className="ghost-button" style={{ fontSize: 11, padding: '5px 10px' }} onClick={() => loadAll()}>
                <RefreshCw size={13} /> Refresh
              </button>
            </div>
          </section>

          {/* Summary banner */}
          <section className="panel" style={{ display: 'grid', gap: 6 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px', fontSize: 13 }}>
              <strong>{nameFor(currentPa.character_id, currentPa.player_id)}</strong>
              <span style={{ color: 'var(--muted)' }}>vs</span>
              <strong>{nameFor(currentPa.pitcher_id, currentPa.pitcher_player_id)}</strong>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 18px', fontSize: 12, color: '#cbd5e1' }}>
              <span>PA #{currentPa.pa_number}</span>
              <span>Result: <strong style={{ color: 'var(--gold)' }}>{formatPaResultLabel(currentPa)}</strong> ({formatResultName(currentPa.result)})</span>
              <span>Inning {currentPa.inning}</span>
              <span>Pitches: {currentPitches.length}</span>
              <span>EV: {formatValue(currentPa.exit_velocity_mph)}{currentPa.exit_velocity_mph != null ? ' mph' : ''}</span>
              <span>LA: {formatValue(currentPa.launch_angle_deg)}{currentPa.launch_angle_deg != null ? '°' : ''}</span>
              <span>Dist: {formatValue(currentPa.hit_distance_ft)}{currentPa.hit_distance_ft != null ? ' ft' : ''}</span>
              <span>Spray: {formatValue(currentPa.hit_angle_deg)}{currentPa.hit_angle_deg != null ? '°' : ''}</span>
              <span>Hang: {formatValue(currentPa.hang_time_sec)}{currentPa.hang_time_sec != null ? ' s' : ''}</span>
              <span>Notation: {formatValue(currentPa.hit_notation)}</span>
            </div>
          </section>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 420px) 1fr', gap: 14, alignItems: 'start' }}>
            {/* Field map */}
            <div style={{ display: 'grid', gap: 10 }}>
              <Section title="Field Map">
                {isBattedBall ? (
                  <>
                    <FieldPlayBuilder
                      stadiumKey={resolvedStadiumKey}
                      landingSpot={landingSpot}
                      secondarySpot={fieldedSpot}
                      primaryMarkerLabel="First landing / catch"
                      secondaryMarkerLabel="Fielded"
                      label=""
                      showFielderMarkers={false}
                    />
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 8 }}>
                      Stadium: {stadiumDisplayName || (gameStadiumKey ? getStadiumNameByKey(gameStadiumKey) : '—')}
                      {currentPa.hit_stadium_key ? '' : ' (from game, PA has no hit_stadium_key)'}
                      {!stadiumConfig ? ' — no stadium config resolved, field not drawn' : ''}
                    </div>
                    {!landingSpot ? <div style={{ fontSize: 11, color: STATUS.MISSING.color, marginTop: 4 }}>No landing spot (hit_x/hit_y missing)</div> : null}
                    {shouldShowFieldedLocation(currentPa) && !fieldedSpot ? (
                      <div style={{ fontSize: 11, color: STATUS.MISSING.color, marginTop: 4 }}>No fielded spot (fielded_x/fielded_y missing) — expected for this result</div>
                    ) : null}
                  </>
                ) : (
                  <p className="muted" style={{ margin: 0, fontSize: 12 }}>Not a batted-ball result ({currentPa.result || '—'}) — no field map for this PA.</p>
                )}
              </Section>

              <Section title="Legend">
                <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11, color: '#cbd5e1', display: 'grid', gap: 4 }}>
                  <li><span style={{ color: '#EAB308', fontWeight: 800 }}>●</span> Gold marker = first landing or catch</li>
                  <li><span style={{ color: '#38BDF8', fontWeight: 800 }}>■</span> Secondary marker = fielded location</li>
                  <li>Negative spray angle = third-base/left-field side</li>
                  <li>Positive spray angle = first-base/right-field side</li>
                </ul>
              </Section>

              <Section title="Raw JSON">
                <div style={{ display: 'grid', gap: 8 }}>
                  <CopyableJson title="Plate appearance" value={currentPa} />
                  <CopyableJson title="Pitches" value={currentPitches} />
                  <CopyableJson title="Runs scored" value={currentRuns} />
                  <CopyableJson title="Game" value={game} />
                  <CopyableJson title="Tracker live stats" value={trackerStats} />
                </div>
              </Section>
            </div>

            {/* Field-by-field dump */}
            <div style={{ display: 'grid', gap: 10 }}>
              <Section title="Identity & Context">
                <div>
                  <div style={{ fontSize: 11, color: '#cbd5e1', marginBottom: 6 }}>
                    Batter: {nameFor(currentPa.character_id, currentPa.player_id)} · Team: {teamName(currentPa.batting_team_id)}
                  </div>
                  <div style={{ fontSize: 11, color: '#cbd5e1', marginBottom: 6 }}>
                    Pitcher: {nameFor(currentPa.pitcher_id, currentPa.pitcher_player_id)} · Team: {teamName(currentPa.defensive_team_id)}
                  </div>
                </div>
                {identitySection.map(([label, field]) => (
                  <DataRow key={field} label={label} field={field} value={currentPa[field]} status={paFieldStatus(field, currentPa)} />
                ))}
              </Section>

              <Section title="Result & Scoring">
                {resultSection.map((field) => (
                  <DataRow key={field} label={field} field={field} value={currentPa[field]} status={paFieldStatus(field, currentPa)} />
                ))}
              </Section>

              <Section title="Batted-Ball Data">
                {battedBallSection.map((field) => (
                  <DataRow key={field} label={field} field={field} value={currentPa[field]} status={paFieldStatus(field, currentPa)} />
                ))}
              </Section>

              <Section title="Special-Play Data">
                {specialSection.map((field) => (
                  <DataRow key={field} label={field} field={field} value={currentPa[field]} status={paFieldStatus(field, currentPa)} />
                ))}
              </Section>

              <Section title="Runner Data">
                {runnerSection.map((field) => (
                  <DataRow key={field} label={field} field={field} value={currentPa[field]} status={paFieldStatus(field, currentPa)} />
                ))}
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#cbd5e1', marginBottom: 4 }}>runs_scored rows ({currentRuns.length})</div>
                  {currentRuns.length ? currentRuns.map((run) => (
                    <div key={run.id} style={{ fontSize: 11, color: '#cbd5e1', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      {nameFor(run.scoring_character_id, run.scoring_player_id)} scored, charged to {nameFor(run.charged_to_pitcher_id, run.charged_to_pitcher_player_id)} · earned: {formatValue(run.is_earned_run)}
                    </div>
                  )) : <div style={{ fontSize: 11, color: 'var(--muted)' }}>None</div>}
                </div>
              </Section>

              <Section title="Video Data">
                {videoSection.map((field) => (
                  <DataRow key={field} label={field} field={field} value={currentPa[field]} status={paFieldStatus(field, currentPa)} />
                ))}
              </Section>

              <Section title={`Pitch Sequence (${currentPitches.length})`}>
                {currentPitches.length ? currentPitches.map((pitch) => (
                  <div key={pitch.id} style={{ marginBottom: 12, paddingBottom: 10, borderBottom: '1px solid var(--line)' }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--gold)', marginBottom: 4 }}>
                      Pitch {pitch.pitch_number_pa} — {formatPitchResultLabel(pitch.result)}
                    </div>
                    {prominentPitchFields.map((field) => (
                      <DataRow key={field} label={field} field={field} value={pitch[field]} status={pitchFieldStatus(field, pitch)} />
                    ))}
                    {Object.keys(pitch).filter((k) => !prominentPitchFields.includes(k)).length ? (
                      <CopyableJson
                        title="Other pitch columns"
                        value={Object.fromEntries(Object.entries(pitch).filter(([k]) => !prominentPitchFields.includes(k)))}
                      />
                    ) : null}
                  </div>
                )) : <p className="muted" style={{ margin: 0, fontSize: 12 }}>No pitches recorded for this PA.</p>}
              </Section>

              {trackerStats ? (
                <Section title="Tracker Live Stats (game-level)">
                  <div style={{ fontSize: 11, color: '#cbd5e1' }}>
                    Snapshot only — one row per game, not per PA. See raw JSON panel for full contents including live_feed.
                  </div>
                </Section>
              ) : null}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
