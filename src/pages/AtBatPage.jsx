import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { supabase } from '../supabaseClient'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import FieldPlayBuilder, { FIELD_POSITIONS, STADIUM_CONFIGS, estimateHitDistance, estimateHitAngle } from '../components/FieldPlayBuilder'
import YouTubePlayer from '../components/YouTubePlayer'
import { extractYouTubeId, parseRawClockInput, formatSecondsAsRawInput } from '../utils/video'
import { battedBallResults } from '../utils/statsCalculator'
import { formatPaResultLabel, formatPitchResultLabel, formatResultName } from '../utils/notation'
import { estimateExitVelocity, exitVelocityDistanceFt } from '../utils/hitDistanceStats'
import { shouldShowFieldedLocation } from '../utils/fieldedLocation'

const TABLES = {
  tournament: { pa: 'plate_appearances', pitches: 'pitches', games: 'games', pitchingStints: 'pitching_stints', runsScored: 'runs_scored' },
  season: { pa: 'season_plate_appearances', pitches: 'season_pitches', games: 'season_schedule', pitchingStints: 'season_pitching_stints', runsScored: 'season_runs_scored' },
}

const HOMER_RESULTS = new Set(['HR', 'IPHR'])

const TRAJECTORY_OPTIONS = ['G', 'L', 'F', 'B']
const RESULT_OPTIONS = ['1B', '2B', '3B', 'HR', 'IPHR', 'BB', 'HBP', 'K', 'GO', 'FO', 'LO', 'DP', 'TP', 'SF', 'SH', 'FC', 'ROE']
const PITCH_RESULT_OPTIONS = ['ball', 'looking', 'swinging_miss', 'foul', 'hbp', 'in_play']
const PITCH_TYPE_OPTIONS = ['fastball', 'curveball', 'changeup']
const STRIKEOUT_TYPE_OPTIONS = [{ value: 'KS', label: 'Swinging' }, { value: 'KL', label: 'Looking' }]

// Recomputes pitch_number_pa + the running ball/strike count for a PA's whole
// pitch sequence, in the order given — needed after add/remove since neither
// operation otherwise keeps those fields internally consistent.
function recountPitchSequence(pitchRows) {
  let balls = 0
  let strikes = 0
  return pitchRows.map((row, index) => {
    const countBallsBefore = balls
    const countStrikesBefore = strikes
    if (row.result === 'ball') balls = Math.min(4, balls + 1)
    else if (row.result === 'looking' || row.result === 'swinging_miss') strikes = Math.min(3, strikes + 1)
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

// A "strike" for the pitches-thrown/strikes-thrown box score count is every
// pitch except a ball or a hit batsman — matches recomputePitchingStatsForGame
// in Scorebook.jsx.
function isStrikeResult(result) {
  return result !== 'ball' && result !== 'hbp'
}

// Same re-entry-aware stint attribution recomputePitchingStatsForGame uses,
// minus the defense-derivation step — pa.pitcher_player_id already holds the
// value that would resolve to (it's where it was copied from when the PA was
// first saved), so this at-bat's own recorded pitcher/player pins it down
// without needing the whole game's inning-by-inning state.
function findActiveStint(stints, pa) {
  if (pa?.pitcher_id == null) return null
  const candidates = stints.filter((s) => String(s.character_id) === String(pa.pitcher_id) && String(s.player_id) === String(pa.pitcher_player_id))
  const eligible = candidates.filter((s) => new Date(s.created_at).getTime() <= new Date(pa.created_at).getTime())
  return eligible[eligible.length - 1] || candidates[0] || null
}

// Mirrors getPaScoringRuns/runsFromPAs in Scorebook.jsx: a game with any
// tracked runsScored rows treats them as the sole source of truth (per-PA
// rbi/run_scored fields are ignored); a never-tracked game falls back to
// those PA fields. Duplicated here (not exported from Scorebook.jsx) so this
// page can recompute the same team score totals after an edit.
function getPaScoringRunsFallback(pa = {}) {
  const isHomer = HOMER_RESULTS.has(pa.result)
  return Number(pa.rbi || 0) + (pa.run_scored && !isHomer ? 1 : 0)
}

function runsFromPAsForPlayer(pas, playerId, runs = []) {
  if (runs.length) {
    return runs.filter((run) => String(run.scoring_player_id) === String(playerId)).length
  }
  return pas.filter((pa) => String(pa.player_id) === String(playerId)).reduce((sum, pa) => sum + getPaScoringRunsFallback(pa), 0)
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
      <span className="muted" style={{ textTransform: 'uppercase', fontWeight: 700, fontSize: 10, letterSpacing: '.05em' }}>{label}</span>
      {children}
    </label>
  )
}

export default function AtBatPage() {
  const { source: rawSource, id } = useParams()
  const source = rawSource === 'season' ? 'season' : 'tournament'
  const tables = TABLES[source]
  const { isScorekeeper } = useAuth()
  const { pushToast } = useToast()

  const [loading, setLoading] = useState(true)
  const [pa, setPa] = useState(null)
  const [pitches, setPitches] = useState([])
  const [pitchingStints, setPitchingStints] = useState([])
  const [game, setGame] = useState(null)
  const [batterName, setBatterName] = useState('')
  const [pitcherName, setPitcherName] = useState('')
  const [editMode, setEditMode] = useState(false)
  const [resultDraft, setResultDraft] = useState(null)
  const [savingResult, setSavingResult] = useState(false)
  const [savingPitchId, setSavingPitchId] = useState(null)
  // Season games only carry team ids on the schedule row (home_team_id/away_team_id),
  // not the controlling player directly — needed to know which of home_score/
  // away_score a given PA's run(s) belong to when recomputing the score below.
  const [seasonTeamPlayerById, setSeasonTeamPlayerById] = useState({})

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)

      const { data: paRow, error: paError } = await supabase
        .from(tables.pa)
        .select('*')
        .eq('id', id)
        .maybeSingle()

      if (cancelled) return

      if (paError || !paRow) {
        setPa(null)
        setLoading(false)
        return
      }

      const [{ data: pitchRows }, { data: gameRow }, { data: character }, { data: pitcherCharacter }, { data: stintRows }, { data: seasonTeamRows }] = await Promise.all([
        supabase.from(tables.pitches).select('*').eq('pa_id', id).order('pitch_number_pa', { ascending: true }),
        supabase.from(tables.games).select('*').eq('id', paRow.game_id).maybeSingle(),
        supabase.from('characters').select('name').eq('id', paRow.character_id).maybeSingle(),
        supabase.from('characters').select('name').eq('id', paRow.pitcher_id).maybeSingle(),
        supabase.from(tables.pitchingStints).select('*').eq('game_id', paRow.game_id),
        source === 'season' ? supabase.from('season_teams').select('id,player_id') : Promise.resolve({ data: null }),
      ])

      if (cancelled) return

      if (seasonTeamRows) {
        setSeasonTeamPlayerById(Object.fromEntries(seasonTeamRows.map((t) => [String(t.id), t.player_id])))
      }

      setPa(paRow)
      setResultDraft(paRow)
      setPitches(pitchRows || [])
      setGame(gameRow || null)
      setBatterName(character?.name || 'Unknown batter')
      setPitcherName(pitcherCharacter?.name || 'Unknown pitcher')
      setPitchingStints(stintRows || [])
      setLoading(false)
    }

    load()

    return () => { cancelled = true }
  }, [tables, id])

  // Stay in sync with edits made elsewhere (Scorebook's At-Bat Data tab,
  // handleSavePlayLocation, or the live scoring flow) while this page is
  // open. Skipped while actively editing so a concurrent update doesn't
  // silently overwrite in-progress form input — the draft is refreshed
  // from the latest row as soon as edit mode is (re-)entered instead, and
  // a toast flags that something changed underneath the user.
  useEffect(() => {
    const channel = supabase
      .channel(`at-bat-${source}-${id}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: tables.pa, filter: `id=eq.${id}` }, (payload) => {
        setPa((current) => (current ? { ...current, ...payload.new } : current))
        setEditMode((editing) => {
          if (editing) {
            pushToast({ title: 'This at-bat was updated elsewhere', message: 'Re-open edit to load the latest values.', type: 'info' })
          } else {
            setResultDraft((current) => (current ? { ...current, ...payload.new } : current))
          }
          return editing
        })
      })
      .subscribe()

    return () => supabase.removeChannel(channel)
  }, [source, id, tables, pushToast])

  // Same "stay in sync with edits made elsewhere" concern as the PA
  // subscription above, but for the pitches list and the pitcher stint this
  // page nudges pitches_thrown/strikes_thrown on — e.g. the live Scorebook
  // adds a pitch to this same at-bat while this tab is sitting open, or vice
  // versa (see Scorebook.jsx's matching refocus resync). Realtime coverage
  // for these tables isn't guaranteed, so refetch on refocus as a fallback
  // rather than relying on postgres_changes alone. Skipped mid-save (a
  // pending insert/delete/recount here would otherwise race its own refetch).
  const paId = pa?.id
  const paGameId = pa?.game_id
  useEffect(() => {
    if (!paId) return
    const resync = async () => {
      if (savingPitchId) return
      const [{ data: freshPitches }, { data: freshStints }] = await Promise.all([
        supabase.from(tables.pitches).select('*').eq('pa_id', paId).order('pitch_number_pa', { ascending: true }),
        supabase.from(tables.pitchingStints).select('*').eq('game_id', paGameId),
      ])
      setPitches(freshPitches || [])
      setPitchingStints(freshStints || [])
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
  }, [paId, paGameId, tables, savingPitchId])

  const videoId = useMemo(() => extractYouTubeId(game?.video_url), [game])
  const canEdit = Boolean(isScorekeeper)
  const isBattedBall = pa ? battedBallResults.has(pa.result) : false

  // Distance and hang time fully determine launch speed/angle for a given
  // batted-ball shape (same real projectile-physics model for every
  // trajectory, grounders included — contact to when it first touches the
  // ground is a real, if brief, airborne phase there too), so keep exit
  // velocity/launch angle in sync whenever either input (or the shape)
  // changes, matching Scorebook's recompute behavior — otherwise a
  // hand-edited distance/hang time would leave a stale exit velocity/launch
  // angle behind. fielded_x/y never feeds this — see AtBatDataEntryPanel's
  // computeShotShapeEstimate for why (it's a different point on the play
  // than what hang_time_sec measures). is_robbed_hr substitutes the assumed
  // true distance instead of hit_distance_ft, same as there.
  function recomputeShotShape(patch) {
    setResultDraft((d) => {
      const next = { ...d, ...patch }
      const config = next.hit_stadium_key ? STADIUM_CONFIGS[next.hit_stadium_key] : null
      const distanceFt = exitVelocityDistanceFt({
        isRobbedHr: next.is_robbed_hr,
        hitDistanceFt: next.hit_distance_ft,
        hitAngleDeg: next.hit_angle_deg,
      }, config)
      const estimate = estimateExitVelocity(distanceFt, next.hang_time_sec)
      return { ...next, exit_velocity_mph: estimate?.exitVelocityMph ?? null, launch_angle_deg: estimate?.launchAngleDeg ?? null }
    })
  }

  // Tapping a new hit location changes the ground truth for distance/angle —
  // recompute both from the tapped spot (same formula the field diagram uses
  // to render its own "### ft" label) rather than leaving the numeric
  // distance field, and everything derived from it, pointing at wherever it
  // was before. Mirrors Scorebook's handleSavePlayLocation.
  function handleFieldTap(spot) {
    const config = pa.hit_stadium_key ? STADIUM_CONFIGS[pa.hit_stadium_key] : null
    const newDistanceFt = config ? estimateHitDistance(spot, config) : null
    const hitAngleDeg = config ? estimateHitAngle(spot, config) : null
    recomputeShotShape({
      hit_x: spot.x,
      hit_y: spot.y,
      hit_distance_ft: newDistanceFt,
      hit_angle_deg: hitAngleDeg,
    })
  }

  // Adding/removing/re-classifying a pitch here bypasses the live Scorebook's
  // own recomputePitchingStatsForGame entirely, so pitching_stints.pitches_thrown/
  // strikes_thrown would otherwise silently drift from the pitches table.
  // Nudges just the one attributed stint by the delta this edit caused.
  async function adjustPitcherCounts(pitchesDelta, strikesDelta) {
    if (!pitchesDelta && !strikesDelta) return
    const stint = findActiveStint(pitchingStints, pa)
    if (!stint) return
    const nextPitches = Math.max(0, Number(stint.pitches_thrown || 0) + pitchesDelta)
    const nextStrikes = Math.max(0, Number(stint.strikes_thrown || 0) + strikesDelta)
    const { error } = await supabase.from(tables.pitchingStints).update({ pitches_thrown: nextPitches, strikes_thrown: nextStrikes }).eq('id', stint.id)
    if (error) {
      pushToast({ title: 'Pitcher stat update failed', message: error.message, type: 'error' })
      return
    }
    setPitchingStints((cur) => cur.map((s) => (s.id === stint.id ? { ...s, pitches_thrown: nextPitches, strikes_thrown: nextStrikes } : s)))
  }

  async function savePitch(pitchId, patch) {
    const normalizedPatch = { ...patch }
    if (normalizedPatch.pitch_type) {
      normalizedPatch.is_star_pitch = false
    }
    if (normalizedPatch.is_star_pitch) {
      normalizedPatch.pitch_type = null
    }
    setSavingPitchId(pitchId)
    const { error } = await supabase.from(tables.pitches).update(normalizedPatch).eq('id', pitchId)
    setSavingPitchId(null)
    if (error) {
      pushToast({ title: 'Pitch save failed', message: error.message, type: 'error' })
      return
    }
    if (Object.prototype.hasOwnProperty.call(normalizedPatch, 'result')) {
      const prevPitch = pitches.find((p) => p.id === pitchId)
      const strikesDelta = Number(isStrikeResult(normalizedPatch.result)) - Number(isStrikeResult(prevPitch?.result))
      if (strikesDelta) await adjustPitcherCounts(0, strikesDelta)
    }
    setPitches((current) => current.map((p) => (p.id === pitchId ? { ...p, ...normalizedPatch } : p)))
  }

  // Persists a full recount (pitch_number_pa + running ball/strike count) for
  // every row that changed — used after add/remove, since either one shifts
  // every pitch after the affected index.
  async function persistRecount(nextRows) {
    const recounted = recountPitchSequence(nextRows)
    const changed = recounted.filter((row, index) => {
      const prior = nextRows[index]
      return prior.pitch_number_pa !== row.pitch_number_pa
        || prior.count_balls_before !== row.count_balls_before
        || prior.count_strikes_before !== row.count_strikes_before
        || prior.count_balls_after !== row.count_balls_after
        || prior.count_strikes_after !== row.count_strikes_after
    })
    await Promise.all(changed.map((row) => supabase.from(tables.pitches).update({
      pitch_number_pa: row.pitch_number_pa,
      count_balls_before: row.count_balls_before,
      count_strikes_before: row.count_strikes_before,
      count_balls_after: row.count_balls_after,
      count_strikes_after: row.count_strikes_after,
    }).eq('id', row.id)))
    setPitches((current) => current.map((p) => recounted.find((r) => r.id === p.id) || p))
  }

  // Inserts a fresh 'ball' pitch at the given position in the sequence (0 =
  // before everything, pitches.length = append at the end) — e.g. inserting
  // at pitches.length - 1 slots a missed pitch in right before the at-bat's
  // final (in-play/strikeout/etc.) pitch, without disturbing that pitch's
  // own result. persistRecount then renumbers/recounts everything after it.
  async function insertPitch(atIndex) {
    if (!pa) return
    setSavingPitchId('__adding__')
    const neighbor = pitches[atIndex] || pitches[atIndex - 1] || null
    // pitch_number_game is a game-wide sequence number (see comparePitchOrder
    // in Scorebook.jsx) — this page's own `pitches` state only holds this
    // PA's rows, so basing the next value on it alone would collide with
    // whatever pitch elsewhere in the game already used that number. Has to
    // be sourced from the whole game's pitches instead.
    const { data: latestGamePitch } = await supabase
      .from(tables.pitches)
      .select('pitch_number_game')
      .eq('game_id', pa.game_id)
      .order('pitch_number_game', { ascending: false })
      .limit(1)
      .maybeSingle()
    const maxPitchNumberGame = Number(latestGamePitch?.pitch_number_game || 0)
    const newPitchPayload = {
      game_id: pa.game_id,
      pa_id: pa.id,
      pitcher_id: neighbor?.pitcher_id || pitcherName,
      pitcher_player: neighbor?.pitcher_player || '',
      batter_id: neighbor?.batter_id || batterName,
      inning: pa.inning,
      half: neighbor?.half || pa.half || pa.pa_half || 'top',
      pitch_number_pa: atIndex + 1,
      pitch_number_game: maxPitchNumberGame + 1,
      is_star_pitch: false,
      result: 'ball',
      pitch_type: null,
      count_balls_before: 0,
      count_strikes_before: 0,
      count_balls_after: 0,
      count_strikes_after: 0,
    }
    const { data: savedPitch, error } = await supabase.from(tables.pitches).insert(newPitchPayload).select().single()
    if (error) {
      setSavingPitchId(null)
      pushToast({ title: 'Add pitch failed', message: error.message, type: 'error' })
      return
    }
    const nextRows = [...pitches.slice(0, atIndex), savedPitch, ...pitches.slice(atIndex)]
    setPitches(nextRows)
    await persistRecount(nextRows)
    await adjustPitcherCounts(1, isStrikeResult(newPitchPayload.result) ? 1 : 0)
    setSavingPitchId(null)
  }

  async function removePitch(pitchId) {
    setSavingPitchId(pitchId)
    const removedPitch = pitches.find((p) => p.id === pitchId)
    const { error } = await supabase.from(tables.pitches).delete().eq('id', pitchId)
    if (error) {
      setSavingPitchId(null)
      pushToast({ title: 'Remove pitch failed', message: error.message, type: 'error' })
      return
    }
    const nextRows = pitches.filter((p) => p.id !== pitchId)
    setPitches(nextRows)
    await persistRecount(nextRows)
    await adjustPitcherCounts(-1, isStrikeResult(removedPitch?.result) ? -1 : 0)
    setSavingPitchId(null)
  }

  // Reorders two adjacent pitches — the set of results is unchanged, so no
  // pitcher-count adjustment is needed, just a recount of pitch_number_pa and
  // the running ball/strike count for whatever now sits between them.
  async function movePitch(pitchId, direction) {
    const index = pitches.findIndex((p) => p.id === pitchId)
    const targetIndex = index + (direction === 'up' ? -1 : 1)
    if (index < 0 || targetIndex < 0 || targetIndex >= pitches.length) return
    const nextRows = [...pitches]
    ;[nextRows[index], nextRows[targetIndex]] = [nextRows[targetIndex], nextRows[index]]
    setSavingPitchId(pitchId)
    setPitches(nextRows)
    await persistRecount(nextRows)
    setSavingPitchId(null)
  }

  // Editing a result/rbi here writes straight to the PA row — nothing else
  // recomputes the scoreboard from that (unlike Scorebook's own edit path,
  // which explicitly re-derives runsScored + games.*_runs/*_score after every
  // save). Left alone, that desyncs the displayed score from the at-bat the
  // moment its result crosses in or out of a home run, or its RBI changes on
  // a game with no run-tracking rows yet. This keeps three things honest:
  //  1. For a game that already tracks individual runsScored rows, the
  //     batter's own run (the only unambiguous one — it doesn't depend on
  //     who else was on base) gets added/removed as the result crosses the
  //     HR/IPHR boundary. Runs driven in for OTHER runners on the bases
  //     aren't touched — reconstructing those needs the full runner-state
  //     machine Scorebook's live entry uses, which this isolated single-PA
  //     editor doesn't have enough context to replay safely.
  //  2. For a game with zero runsScored rows (never tracked), the score is
  //     derived straight from rbi/run_scored across all its PAs — those are
  //     already the fields this editor writes, so no extra step is needed
  //     beyond recomputing the totals.
  //  3. Either way, games.team_a_runs/team_b_runs (or season's away_score/
  //     home_score) get rewritten from the fresh totals so the scoreboard
  //     actually reflects them.
  async function syncGameScore(previousResult, savedPa) {
    if (!game) return
    const { data: gameRuns } = await supabase.from(tables.runsScored).select('*').eq('game_id', savedPa.game_id)
    const isTracked = (gameRuns || []).length > 0
    let runsForRecompute = gameRuns || []
    if (isTracked) {
      const wasHR = HOMER_RESULTS.has(previousResult)
      const isHR = HOMER_RESULTS.has(savedPa.result)
      const ownRunIndex = runsForRecompute.findIndex((run) => (
        String(run.pa_id) === String(savedPa.id)
        && String(run.scoring_character_id) === String(savedPa.character_id)
        && String(run.scoring_player_id) === String(savedPa.player_id)
      ))
      if (isHR && !wasHR && ownRunIndex === -1) {
        const { data: inserted, error } = await supabase.from(tables.runsScored).insert({
          game_id: savedPa.game_id,
          pa_id: savedPa.id,
          inning: savedPa.inning,
          half: savedPa.half || savedPa.pa_half || 'top',
          scoring_player_id: savedPa.player_id,
          scoring_character_id: savedPa.character_id,
          charged_to_pitcher_id: savedPa.pitcher_id,
          charged_to_pitcher_player_id: savedPa.pitcher_player_id,
          is_earned_run: true,
        }).select().single()
        if (error) {
          pushToast({ title: 'Score sync failed', message: error.message, type: 'error' })
        } else if (inserted) {
          runsForRecompute = [...runsForRecompute, inserted]
        }
      } else if (!isHR && wasHR && ownRunIndex !== -1) {
        const removedId = runsForRecompute[ownRunIndex].id
        const { error } = await supabase.from(tables.runsScored).delete().eq('id', removedId)
        if (error) {
          pushToast({ title: 'Score sync failed', message: error.message, type: 'error' })
        } else {
          runsForRecompute = runsForRecompute.filter((run) => run.id !== removedId)
        }
      }
    }

    const { data: allPAs } = await supabase.from(tables.pa).select('*').eq('game_id', savedPa.game_id)
    const pas = allPAs || []
    let teamAPlayerId
    let teamBPlayerId
    if (source === 'season') {
      teamAPlayerId = seasonTeamPlayerById[String(game.away_team_id)]
      teamBPlayerId = seasonTeamPlayerById[String(game.home_team_id)]
    } else {
      teamAPlayerId = game.team_a_player_id
      teamBPlayerId = game.team_b_player_id
    }
    const teamARuns = runsFromPAsForPlayer(pas, teamAPlayerId, runsForRecompute)
    const teamBRuns = runsFromPAsForPlayer(pas, teamBPlayerId, runsForRecompute)
    const scorePayload = source === 'season'
      ? { away_score: teamARuns, home_score: teamBRuns }
      : { team_a_runs: teamARuns, team_b_runs: teamBRuns }
    const { error: scoreError } = await supabase.from(tables.games).update(scorePayload).eq('id', savedPa.game_id)
    if (scoreError) {
      pushToast({ title: 'Score sync failed', message: scoreError.message, type: 'error' })
      return
    }
    setGame((current) => (current ? { ...current, ...scorePayload } : current))
  }

  async function saveResult() {
    if (!resultDraft) return
    setSavingResult(true)
    const payload = {
      result: resultDraft.result,
      trajectory: resultDraft.trajectory,
      hit_location: resultDraft.hit_location,
      hit_x: resultDraft.hit_x,
      hit_y: resultDraft.hit_y,
      hit_distance_ft: resultDraft.hit_distance_ft,
      hit_angle_deg: resultDraft.hit_angle_deg,
      exit_velocity_mph: resultDraft.exit_velocity_mph,
      launch_angle_deg: resultDraft.launch_angle_deg,
      hang_time_sec: resultDraft.hang_time_sec,
      video_timestamp_start_sec: resultDraft.video_timestamp_start_sec,
      video_timestamp_end_sec: resultDraft.video_timestamp_end_sec,
      rbi: resultDraft.rbi,
      run_scored: HOMER_RESULTS.has(resultDraft.result) ? true : Boolean(resultDraft.run_scored),
      star_hit_used: Boolean(resultDraft.star_hit_used),
      strikeout_type: resultDraft.result === 'K' ? resultDraft.strikeout_type : null,
      is_official_ab: Boolean(resultDraft.is_official_ab),
      fielder_choice_out: Boolean(resultDraft.fielder_choice_out),
      is_buddy_jump: Boolean(resultDraft.is_buddy_jump),
      buddy_jump_assist_position: resultDraft.is_buddy_jump ? resultDraft.buddy_jump_assist_position : null,
      buddy_jump_putout_position: resultDraft.is_buddy_jump ? resultDraft.buddy_jump_putout_position : null,
      is_robbed_hr: Boolean(resultDraft.is_robbed_hr),
    }
    const previousResult = pa.result
    const { data: savedPa, error } = await supabase.from(tables.pa).update(payload).eq('id', pa.id).select().single()
    if (error) {
      setSavingResult(false)
      pushToast({ title: 'Save failed', message: error.message, type: 'error' })
      return
    }
    if (previousResult !== savedPa.result || Number(pa.rbi || 0) !== Number(savedPa.rbi || 0)) {
      await syncGameScore(previousResult, savedPa)
    }
    setSavingResult(false)
    setPa((current) => ({ ...current, ...payload }))
    pushToast({ title: 'At-bat updated', type: 'success' })
    setEditMode(false)
  }

  if (loading) {
    return (
      <div className="page-shell">
        <section className="panel"><p className="muted" style={{ margin: 0 }}>Loading at-bat…</p></section>
      </div>
    )
  }

  if (!pa) {
    return (
      <div className="page-shell">
        <section className="panel"><p className="muted" style={{ margin: 0 }}>At-bat not found.</p></section>
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gap: 20, maxWidth: 860, margin: '0 auto' }}>
      <Link
        to="#"
        onClick={(e) => {
          e.preventDefault()
          // Reached either from a same-tab spray-chart click (real history
          // to go back to) or from At-Bat Data's "Edit At-Bat" link, which
          // opens this in a brand-new tab — there, history.back() has
          // nothing to go back to and just no-ops, which is what was
          // reported as "the back button doesn't do anything." A fresh
          // tab's history stack is always length 1 (just this page), so
          // that's what distinguishes the two cases; close the tab instead
          // when there's nowhere for back() to actually go.
          if (window.history.length > 1) window.history.back()
          else window.close()
        }}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--muted, #94A3B8)', fontSize: 13, textDecoration: 'none' }}
      >
        <ArrowLeft size={16} /> Back
      </Link>

      <section className="panel" style={{ padding: 20, display: 'grid', gap: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 800 }}>{batterName} vs {pitcherName}</h1>
            <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
              Inning {pa.inning} · {formatPaResultLabel(pa)}
              {pa.rbi ? ` · ${pa.rbi} RBI` : ''}
            </div>
          </div>
          {canEdit ? (
            <button
              type="button"
              className="ghost-button"
              onClick={() => {
                if (!editMode) setResultDraft(pa)
                setEditMode((v) => !v)
              }}
            >
              {editMode ? 'Cancel' : 'Edit at-bat'}
            </button>
          ) : null}
        </div>

        <YouTubePlayer videoId={videoId} startSec={pa.video_timestamp_start_sec} endSec={pa.video_timestamp_end_sec} />
        {!videoId ? (
          <div className="muted" style={{ fontSize: 12 }}>
            No video linked to this game
          </div>
        ) : null}
      </section>

      <section className="panel" style={{ padding: 20, display: 'grid', gap: 12 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>Pitch by pitch</h2>
        {pitches.length === 0 && !(canEdit && editMode) ? (
          <div className="muted" style={{ fontSize: 13 }}>No pitches recorded for this at-bat.</div>
        ) : (
          <div style={{ display: 'grid', gap: 6 }}>
            <div style={{ display: 'grid', gridTemplateColumns: `30px 1fr 110px 60px 60px 60px ${canEdit && editMode ? '104px' : '0px'}`, gap: 8, fontSize: 10, fontWeight: 800, textTransform: 'uppercase', color: 'var(--muted, #94A3B8)', padding: '0 8px' }}>
              <div>#</div>
              <div>Result</div>
              <div>Pitch Type</div>
              <div>Star Hit</div>
              <div>Star Pitch</div>
              <div>Count</div>
              <div></div>
            </div>
            {pitches.map((pitch, index) => (
              <div key={pitch.id} style={{ display: 'grid', gap: 6 }}>
                {canEdit && editMode ? (
                  <button
                    type="button"
                    className="ghost-button"
                    disabled={Boolean(savingPitchId)}
                    onClick={() => insertPitch(index)}
                    title="Insert a pitch before this one"
                    style={{ fontSize: 10, padding: '2px 8px', justifySelf: 'start', opacity: 0.7 }}
                  >
                    + Insert pitch here
                  </button>
                ) : null}
                <div style={{ display: 'grid', gridTemplateColumns: `30px 1fr 110px 60px 60px 60px ${canEdit && editMode ? '104px' : '0px'}`, gap: 8, alignItems: 'center', padding: '8px', borderRadius: 8, border: '1px solid var(--border, rgba(148,163,184,0.2))' }}>
                  <div>{pitch.pitch_number_pa}</div>
                  {canEdit && editMode ? (
                    <select
                      value={pitch.result || ''}
                      disabled={savingPitchId === pitch.id}
                      onChange={(e) => savePitch(pitch.id, { result: e.target.value })}
                    >
                      {PITCH_RESULT_OPTIONS.map((opt) => <option key={opt} value={opt}>{formatPitchResultLabel(opt)}</option>)}
                    </select>
                  ) : (
                    <div>
                      {pitch.result === 'in_play'
                        ? `In Play (${formatResultName(pa.result)})`
                        : formatPitchResultLabel(pitch.result)}
                    </div>
                  )}
                  {canEdit && editMode ? (
                    <select
                      value={pitch.pitch_type || ''}
                      disabled={savingPitchId === pitch.id}
                      onChange={(e) => savePitch(pitch.id, { pitch_type: e.target.value || null })}
                    >
                      <option value="">—</option>
                      {PITCH_TYPE_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt[0].toUpperCase() + opt.slice(1)}</option>)}
                    </select>
                  ) : (
                    <div className="muted">{pitch.pitch_type ? pitch.pitch_type[0].toUpperCase() + pitch.pitch_type.slice(1) : '—'}</div>
                  )}
                  <div className="muted">{pa.star_hit_used && index === pitches.length - 1 ? 'Yes' : 'No'}</div>
                  <div className="muted">{pitch.is_star_pitch ? 'Yes' : 'No'}</div>
                  <div className="muted">{pitch.count_balls_after}-{pitch.count_strikes_after}</div>
                  {canEdit && editMode ? (
                    <div style={{ display: 'flex', gap: 2 }}>
                      <button
                        type="button"
                        className="ghost-button"
                        disabled={Boolean(savingPitchId) || index === 0}
                        onClick={() => movePitch(pitch.id, 'up')}
                        title="Move up"
                        style={{ padding: '4px 6px' }}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        disabled={Boolean(savingPitchId) || index === pitches.length - 1}
                        onClick={() => movePitch(pitch.id, 'down')}
                        title="Move down"
                        style={{ padding: '4px 6px' }}
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        className="ghost-button"
                        disabled={savingPitchId === pitch.id}
                        onClick={() => removePitch(pitch.id)}
                        title="Remove pitch"
                        style={{ padding: '4px 6px' }}
                      >
                        ✕
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
        {canEdit && editMode ? (
          <div>
            <button type="button" className="ghost-button" disabled={Boolean(savingPitchId)} onClick={() => insertPitch(pitches.length)}>
              {savingPitchId === '__adding__' ? 'Adding…' : '+ Add pitch'}
            </button>
          </div>
        ) : null}
      </section>

      <section className="panel" style={{ padding: 20, display: 'grid', gap: 16 }}>
        <h2 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>Result</h2>

        {canEdit && editMode ? (
          <div style={{ display: 'grid', gap: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12 }}>
              <Field label="Result">
                <select
                  value={resultDraft.result || ''}
                  onChange={(e) => {
                    const nextResult = e.target.value
                    setResultDraft((d) => ({
                      ...d,
                      result: nextResult,
                      // A solo HR is 1 RBI at minimum — without this, an
                      // at-bat switched to HR with rbi still at 0 would
                      // silently undercount the batter's own run on a game
                      // with no runsScored rows tracked yet (see
                      // syncGameScore). Only nudges when rbi is unset/0, so
                      // an intentionally-entered multi-run HR isn't clobbered.
                      rbi: HOMER_RESULTS.has(nextResult) && !d.rbi ? 1 : d.rbi,
                    }))
                  }}
                >
                  {RESULT_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              </Field>
              <Field label="Trajectory">
                <select value={resultDraft.trajectory || ''} onChange={(e) => recomputeShotShape({ trajectory: e.target.value || null })}>
                  <option value="">—</option>
                  {TRAJECTORY_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              </Field>
              <Field label="Exit velocity (mph)">
                <input type="number" step="0.1" value={resultDraft.exit_velocity_mph ?? ''} onChange={(e) => setResultDraft((d) => ({ ...d, exit_velocity_mph: e.target.value === '' ? null : Number(e.target.value) }))} />
              </Field>
              <Field label="Launch angle (deg)">
                <input type="number" step="0.1" value={resultDraft.launch_angle_deg ?? ''} onChange={(e) => setResultDraft((d) => ({ ...d, launch_angle_deg: e.target.value === '' ? null : Number(e.target.value) }))} />
              </Field>
              <Field label="Hit distance (ft)">
                <input type="number" step="1" value={resultDraft.hit_distance_ft ?? ''} onChange={(e) => recomputeShotShape({ hit_distance_ft: e.target.value === '' ? null : Number(e.target.value) })} />
              </Field>
              <Field label="Hang time (sec)">
                <input type="number" step="0.01" value={resultDraft.hang_time_sec ?? ''} onChange={(e) => recomputeShotShape({ hang_time_sec: e.target.value === '' ? null : Number(e.target.value) })} />
              </Field>
              <Field label="Video start (e.g. 1054)">
                <input
                  type="text"
                  inputMode="numeric"
                  value={resultDraft.video_timestamp_start_text ?? formatSecondsAsRawInput(resultDraft.video_timestamp_start_sec)}
                  onChange={(e) => setResultDraft((d) => ({ ...d, video_timestamp_start_text: e.target.value, video_timestamp_start_sec: parseRawClockInput(e.target.value) }))}
                />
              </Field>
              <Field label="Video end (e.g. 1054)">
                <input
                  type="text"
                  inputMode="numeric"
                  value={resultDraft.video_timestamp_end_text ?? formatSecondsAsRawInput(resultDraft.video_timestamp_end_sec)}
                  onChange={(e) => setResultDraft((d) => ({ ...d, video_timestamp_end_text: e.target.value, video_timestamp_end_sec: parseRawClockInput(e.target.value) }))}
                />
              </Field>
              <Field label="RBI">
                <input type="number" step="1" min="0" value={resultDraft.rbi ?? 0} onChange={(e) => setResultDraft((d) => ({ ...d, rbi: e.target.value === '' ? 0 : Number(e.target.value) }))} />
              </Field>
              {resultDraft.result === 'K' ? (
                <Field label="Strikeout type">
                  <select value={resultDraft.strikeout_type || ''} onChange={(e) => setResultDraft((d) => ({ ...d, strikeout_type: e.target.value || null }))}>
                    <option value="">—</option>
                    {STRIKEOUT_TYPE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                  </select>
                </Field>
              ) : null}
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={HOMER_RESULTS.has(resultDraft.result) ? true : Boolean(resultDraft.run_scored)}
                  disabled={HOMER_RESULTS.has(resultDraft.result)}
                  onChange={(e) => setResultDraft((d) => ({ ...d, run_scored: e.target.checked }))}
                />
                Batter scored{HOMER_RESULTS.has(resultDraft.result) ? ' (always true on a HR)' : ''}
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <input type="checkbox" checked={Boolean(resultDraft.star_hit_used)} onChange={(e) => setResultDraft((d) => ({ ...d, star_hit_used: e.target.checked }))} />
                Star hit used
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <input type="checkbox" checked={Boolean(resultDraft.is_official_ab)} onChange={(e) => setResultDraft((d) => ({ ...d, is_official_ab: e.target.checked }))} />
                Official at-bat
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <input type="checkbox" checked={Boolean(resultDraft.fielder_choice_out)} onChange={(e) => setResultDraft((d) => ({ ...d, fielder_choice_out: e.target.checked }))} />
                Fielder's choice out
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <input type="checkbox" checked={Boolean(resultDraft.is_buddy_jump)} onChange={(e) => setResultDraft((d) => ({ ...d, is_buddy_jump: e.target.checked }))} />
                Buddy jump
              </label>
              {resultDraft.is_buddy_jump ? (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                  <input type="checkbox" checked={Boolean(resultDraft.is_robbed_hr)} onChange={(e) => setResultDraft((d) => ({ ...d, is_robbed_hr: e.target.checked }))} />
                  Robbed HR
                </label>
              ) : null}
            </div>

            {resultDraft.is_buddy_jump ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12 }}>
                <Field label="Buddy jump assist">
                  <select value={resultDraft.buddy_jump_assist_position ?? ''} onChange={(e) => setResultDraft((d) => ({ ...d, buddy_jump_assist_position: e.target.value === '' ? null : Number(e.target.value) }))}>
                    <option value="">—</option>
                    {FIELD_POSITIONS.map((p) => <option key={p.position} value={p.position}>{p.label}</option>)}
                  </select>
                </Field>
                <Field label="Buddy jump putout">
                  <select value={resultDraft.buddy_jump_putout_position ?? ''} onChange={(e) => setResultDraft((d) => ({ ...d, buddy_jump_putout_position: e.target.value === '' ? null : Number(e.target.value) }))}>
                    <option value="">—</option>
                    {FIELD_POSITIONS.map((p) => <option key={p.position} value={p.position}>{p.label}</option>)}
                  </select>
                </Field>
              </div>
            ) : null}

            <FieldPlayBuilder
              landingSpot={resultDraft.hit_x != null && resultDraft.hit_y != null ? { x: resultDraft.hit_x, y: resultDraft.hit_y } : null}
              onFieldTap={handleFieldTap}
              allowFielderSelection={false}
              label="Hit location"
              stadiumKey={pa.hit_stadium_key || null}
            />

            <div>
              <button type="button" className="primary-button" onClick={saveResult} disabled={savingResult}>
                {savingResult ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12, fontSize: 13 }}>
            <div><span className="muted">Result</span><div>{formatPaResultLabel(pa)}</div></div>
            <div><span className="muted">Trajectory</span><div>{pa.trajectory || '—'}</div></div>
            <div><span className="muted">Exit velocity</span><div>{pa.exit_velocity_mph != null ? `${pa.exit_velocity_mph} mph` : '—'}</div></div>
            <div><span className="muted">Launch angle</span><div>{pa.launch_angle_deg != null ? `${pa.launch_angle_deg}°` : '—'}</div></div>
            <div><span className="muted">Distance</span><div>{pa.hit_distance_ft != null ? `${pa.hit_distance_ft} ft` : '—'}</div></div>
            <div><span className="muted">Hang time</span><div>{pa.hang_time_sec != null ? `${pa.hang_time_sec} sec` : '—'}</div></div>
            <div><span className="muted">RBI</span><div>{pa.rbi || 0}</div></div>
            <div><span className="muted">Official AB</span><div>{pa.is_official_ab ? 'Yes' : 'No'}</div></div>
            {pa.is_buddy_jump ? <div><span className="muted">Buddy jump</span><div>Yes{pa.is_robbed_hr ? ' (robbed HR)' : ''}</div></div> : null}
            {isBattedBall && pa.hit_x != null ? (
              <div style={{ gridColumn: '1 / -1' }}>
                <FieldPlayBuilder
                  landingSpot={{ x: pa.hit_x, y: pa.hit_y }}
                  secondarySpot={shouldShowFieldedLocation(pa) && pa.fielded_x != null && pa.fielded_y != null ? { x: pa.fielded_x, y: pa.fielded_y } : null}
                  allowFielderSelection={false}
                  showFielderMarkers={false}
                  label="Hit / Fielded location"
                  stadiumKey={pa.hit_stadium_key || null}
                />
              </div>
            ) : null}
          </div>
        )}
      </section>
    </div>
  )
}
