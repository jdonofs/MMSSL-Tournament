// Movement and fielding facts written while the game is still being played.
//
// The collector derives each play at the dead ball (player_live_derivation.py)
// and the bridge joins it to its at-bat. This module takes a joined play whose
// plate appearance is already saved and writes its tracking_plays row and the
// fielding, movement and throw rows under it -- through
// writeTrackingPlayFacts, the same writer the postgame ingest uses, so a live
// row and a postgame row mean the same thing.
//
// THE LIVE ROWS ARE A VERSION, NOT THE RECORD. They go into a tracking session
// with status `live`. The postgame ingest always opens a replacement version
// beside it and activates that, so the authoritative pass supersedes every
// live row in one transaction (see 20260908123000_tracking_session_versions.sql).
// A database without that migration cannot supersede anything, and live rows
// there would block the postgame ingest outright, so this writes nothing on one.
//
// WHAT IS NOT WRITTEN LIVE:
//   * a play that is not `joined` -- pending, orphaned, ambiguous or mismatched
//     plays wait for the postgame pass, which joins the whole session at once;
//   * the official links (plate_appearances.tracking_session_id, the measured
//     runner kinematics on runner_opportunities) -- those move only with the
//     fenced activation of a finished version;
//   * runner and double-play run values, which need the whole-league refit.
// Catch probability and OAA ARE written, scored against a model fitted once
// from every active opportunity already in the database.

import fs from 'node:fs'
import { fetchAllRows } from '../src/utils/fetchAllRows.js'
import { fetchSupersededTrackingPlayIds, isLegacyTrackingSchema, onlyActiveTrackingFacts } from '../src/utils/activeTrackingVersions.js'
import { fitFieldingModel, scoreFieldingOpportunity } from '../src/utils/advancedDefense.js'
import { indexCharactersByName } from './tracker_character_ids.mjs'
import { isFairPlay } from './tracker_play_join.mjs'
import { insertOneReconciled, selectByKey } from './tracker_persistence.mjs'
import {
  LIVE_SESSION_STATUS,
  recordedTimestamp,
  sessionStem,
  writeTrackingPlayFacts,
} from './ingest_player_tracking.mjs'

// The same thresholds the postgame ingest quarantines a session on. Past them
// the capture is not trusted, so nothing more is written live.
const MAX_MISSED_FRAME_RATE = 0.02

function finite(value, fallback = null) {
  if (value == null || value === '') return fallback
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function readHeader(stem) {
  try {
    return JSON.parse(fs.readFileSync(`${stem}.json`, 'utf8'))
  } catch {
    return {}
  }
}

export function captureIsQuarantined(capture = {}) {
  if (capture.fielder_pointers_left_region) return true
  const frames = finite(capture.frames, 0)
  const missed = finite(capture.missed_frames, 0)
  return frames + missed > 0 && missed / (frames + missed) > MAX_MISSED_FRAME_RATE
}

/**
 * The plate appearance a live play is written against, or why it must wait.
 *
 * Only a `joined` play is written. A fair ball needs its plate appearance
 * saved first; a foul ball is never an at-bat's outcome and is written without
 * one, exactly as the postgame join writes it.
 */
export function liveMatchForPlay(play, join, plateAppearanceFor) {
  if (!play?.batted_ball_class) return { wait: 'the play has no batted-ball class' }
  if (join?.status !== 'joined') return { wait: `join is ${join?.status || 'not run'}` }
  if (!isFairPlay(play)) return { match: { pa: null, method: 'non_fair', confidence: 1 } }
  const pa = plateAppearanceFor(join.pa_number)
  if (!pa?.id) return { wait: 'its plate appearance is not saved yet' }
  return { match: { pa, method: 'live_join', confidence: 0.98 } }
}

export function createLiveTrackingPersistence({
  supabase,
  competitionType,
  gameId,
  sourceId = null,
  log = () => {},
  headerFor = readHeader,
} = {}) {
  let disabledReason = null
  let session = null
  let context = null
  let nextOrdinal = 1
  const written = new Set()
  const persistedPlays = []
  const reservedOrdinals = new Map()
  let quarantineLogged = false

  const fielderTable = competitionType === 'season' ? 'season_game_fielders' : 'game_fielders'

  function disable(reason) {
    if (disabledReason) return
    disabledReason = reason
    log(`live tracking writes are off for this game: ${reason}`)
  }

  async function loadFielders() {
    const result = await fetchAllRows(() => supabase.from(fielderTable).select('*').eq('game_id', gameId))
    if (result.error) throw result.error
    return result.data || []
  }

  async function loadContext() {
    const [fielders, characterResult, seasonTeamResult, fieldingResult, superseded] = await Promise.all([
      loadFielders(),
      fetchAllRows(() => supabase.from('characters').select('id,name')),
      competitionType === 'season'
        ? fetchAllRows(() => supabase.from('season_teams').select('id,player_id'))
        : Promise.resolve({ data: [], error: null }),
      fetchAllRows(() => supabase.from('fielding_opportunities').select('*')),
      fetchSupersededTrackingPlayIds(supabase),
    ])
    const failed = characterResult.error || seasonTeamResult.error
      || fieldingResult.error || superseded.error
    if (failed) throw failed
    const history = onlyActiveTrackingFacts(fieldingResult.data || [], superseded.data)
      .filter((row) => !(String(row.game_id) === String(gameId) && row.competition_type === competitionType))
    return {
      fielders,
      charactersByName: indexCharactersByName(characterResult.data || []),
      seasonTeamPlayerById: new Map((seasonTeamResult.data || []).map((row) => [String(row.id), row.player_id])),
      // Every OTHER game's active opportunities, plus this game's as they are
      // written. A live row is scored against plays that happened before it,
      // which is the out-of-sample reading of the postgame leave-one-out.
      fieldingHistory: history,
    }
  }

  async function ensureSession(stem) {
    if (session) return session
    const probe = await supabase.from('tracking_sessions').select('id,is_active').limit(1)
    if (probe.error) {
      if (isLegacyTrackingSchema(probe.error)) {
        disable('the database does not version tracking sessions, so the postgame ingest could not replace live rows '
          + '(apply supabase/migrations/20260908123000_tracking_session_versions.sql)')
        return null
      }
      throw probe.error
    }
    const rawStem = sessionStem(stem)
    const key = { competition_type: competitionType, game_id: gameId, raw_stem: rawStem }
    const existing = await selectByKey(supabase, 'tracking_sessions', key)
    const active = existing.find((row) => row.is_active !== false) || null
    if (active && active.status !== LIVE_SESSION_STATUS) {
      disable(`session ${active.id} for this capture is already ${active.status}`)
      return null
    }
    context = await loadContext()
    if (active) {
      // A bridge restarted against the same capture: carry on in its live
      // version instead of opening a second one. A parent is not proof that
      // its separately-written children committed, so sync() replays each
      // parent through the reconciled fact writer before marking it written.
      session = active
      const plays = await selectByKey(supabase, 'tracking_plays', { tracking_session_id: active.id })
      for (const row of plays) {
        persistedPlays.push(row)
        nextOrdinal = Math.max(nextOrdinal, finite(row.play_ordinal, 0) + 1)
      }
      log(`resuming live tracking session ${active.id} (${plays.length} plays to verify)`)
      return session
    }
    const header = headerFor(rawStem)
    const saved = await insertOneReconciled(supabase, 'tracking_sessions', {
      competition_type: competitionType,
      game_id: gameId,
      source_id: finite(sourceId),
      stadium_key: header.park || null,
      format_version: header.format || 'MSSTRK02',
      status: LIVE_SESSION_STATUS,
      recorded_utc: recordedTimestamp(header.recorded_utc),
      raw_stem: rawStem,
      raw_manifest_path: header.manifest_path || null,
      frame_rate: finite(header.frame_rate, 59.94),
      calibration: {},
      quality: { derivation: 'live' },
    }, { key })
    session = saved.row
    log(`opened live tracking session ${session.id} for ${rawStem}`)
    return session
  }

  function persistedPlayFor(play, match) {
    const contactFrame = finite(play?.contact_timer)
    const byContact = persistedPlays.find((row) => finite(row.contact_frame) === contactFrame)
    if (byContact) return byContact
    const paId = match?.pa?.id
    return paId == null ? null : persistedPlays.find((row) => String(row.pa_id) === String(paId)) || null
  }

  function ordinalFor(play, match) {
    const contactFrame = finite(play?.contact_timer)
    const persisted = persistedPlayFor(play, match)
    if (persisted) return finite(persisted.play_ordinal)
    if (reservedOrdinals.has(contactFrame)) return reservedOrdinals.get(contactFrame)
    const ordinal = nextOrdinal++
    reservedOrdinals.set(contactFrame, ordinal)
    return ordinal
  }

  async function persistedChildrenComplete(play, trackingPlayId) {
    const read = (table) => selectByKey(supabase, table, { tracking_play_id: trackingPlayId })
    const [fielding, movement, throws] = await Promise.all([
      read('fielding_opportunities'), read('movement_metrics'), read('tracking_throws'),
    ])
    let approaches = []
    let approachesAvailable = true
    try {
      approaches = await read('tracking_catch_approaches')
    } catch (error) {
      const code = String(error?.code || '')
      if (code !== 'PGRST205' && code !== '42P01') throw error
      approachesAvailable = false
    }
    const has = (rows, fields) => fields.every((expected) => rows.some((row) =>
      Object.entries(expected).every(([field, value]) => String(row[field]) === String(value))))
    const fieldingKeys = Object.keys(play.fielders || {}).map((position) => ({ position }))
    const movementKeys = [
      ...Object.keys(play.fielders || {}).map((actor_slot) => ({ actor_type: 'fielder', actor_slot })),
      ...Object.keys(play.runners || {}).map((actor_slot) => ({
        actor_type: actor_slot === 'BAT' ? 'batter' : 'runner', actor_slot,
      })),
    ]
    const throwKeys = (play.throws || []).filter((row) => row.is_throw !== false)
      .map((row, index) => ({ throw_sequence: row.sequence ?? index + 1 }))
    const approachKeys = (play.catch_approaches || []).filter((row) => row.position || row.by)
      .map((row) => ({ position: row.by, start_frame: finite(row.start_frame) }))
    return has(fielding, fieldingKeys)
      && has(movement, movementKeys)
      && has(throws, throwKeys)
      && (!approachesAvailable || has(approaches, approachKeys))
  }

  /**
   * Write every joined play not written yet. Safe to call as often as plays
   * or plate appearances arrive; a play is written once.
   */
  async function sync({ stem, capture = {}, plays = [], joinFor, plateAppearanceFor }) {
    if (disabledReason || !stem) return { written: 0 }
    if (captureIsQuarantined(capture)) {
      if (!quarantineLogged) {
        quarantineLogged = true
        log('live tracking writes paused: the capture is past the quarantine threshold; the postgame pass decides')
      }
      return { written: 0 }
    }
    let count = 0
    let fieldersRefreshed = false
    for (const play of plays) {
      const contactFrame = finite(play?.contact_timer)
      if (contactFrame == null) continue
      const { match } = liveMatchForPlay(play, joinFor(play), plateAppearanceFor)
      if (!match) continue
      if (!(await ensureSession(stem))) return { written: count }
      // ensureSession() is what discovers completed work after a restart, so
      // this check must happen after it. Persisted parents are deliberately
      // not put in `written` until all of their children reconcile below.
      if (written.has(contactFrame)) continue
      // Once per sync that writes: a substitution made since the last play
      // changes who stood at the position this play charges.
      if (!fieldersRefreshed) {
        context.fielders = await loadFielders()
        fieldersRefreshed = true
      }
      const header = headerFor(sessionStem(stem))
      const persisted = persistedPlayFor(play, match)
      const wasComplete = persisted
        ? await persistedChildrenComplete(play, persisted.id)
        : false
      const ordinal = ordinalFor(play, match)
      const model = fitFieldingModel(context.fieldingHistory)
      const result = await writeTrackingPlayFacts(supabase, {
        play,
        playOrdinal: ordinal,
        match,
        trackingSession: session,
        header,
        competitionType,
        gameId,
        fielders: context.fielders,
        seasonTeamPlayerById: context.seasonTeamPlayerById,
        charactersByName: context.charactersByName,
        quarantined: false,
        decorateOpportunity: (row) => ({ ...row, ...(scoreFieldingOpportunity(model, row) || {}) }),
        stageRunnerFacts: false,
      })
      // This read is also the completion fence. If it fails after the child
      // writes committed, the play remains retryable and the same ordinal is
      // replayed on the next sync. Only then may its opportunities influence
      // the following play's live model.
      const opportunities = await selectByKey(supabase, 'fielding_opportunities', {
        tracking_play_id: result.trackingPlay.id,
      })
      context.fieldingHistory.push(...opportunities)
      if (!persisted) {
        persistedPlays.push(result.trackingPlay)
      } else {
        reservedOrdinals.delete(contactFrame)
      }
      if (!wasComplete) count += 1
      written.add(contactFrame)
    }
    return { written: count }
  }

  return {
    sync,
    get disabledReason() { return disabledReason },
    get sessionId() { return session?.id ?? null },
  }
}
