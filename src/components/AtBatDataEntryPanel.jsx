import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import YouTubePlayer from './YouTubePlayer'
import FieldPlayBuilder, { STADIUM_CONFIGS, estimateHitDistance, estimateHitAngle, estimateWallDistanceAtAngle } from './FieldPlayBuilder'
import UnsavedChangesPrompt from './UnsavedChangesPrompt'
import { useConfirmedAction } from '../hooks/useUnsavedChangesGuard'
import { useToast } from '../context/ToastContext'
import { estimateExitVelocity, exitVelocityDistanceFt, ROBBED_HR_WALL_MARGIN_FT } from '../utils/hitDistanceStats'
import { assembleNotation, formatPaResultLabel, formatPitchResultLabel } from '../utils/notation'
import { shouldShowFieldedLocation } from '../utils/fieldedLocation'
import { extractYouTubeId } from '../utils/video'
import { battedBallResults } from '../utils/statsCalculator'

const TRAJECTORY_OPTIONS = ['G', 'L', 'F', 'B']
// Pitch type as labeled from game video, one per thrown pitch. Optional —
// left null for pitches the scorer can't confidently classify.
const PITCH_TYPE_OPTIONS = [
  { value: 'fastball', label: 'Fastball' },
  { value: 'curveball', label: 'Curveball' },
  { value: 'changeup', label: 'Changeup' },
]
// Star pitch is tracked on its own is_star_pitch column, not pitch_type — but
// it's shown alongside the other pitch types here since a pitch is only ever
// one or the other. Selecting it clears pitch_type (a star pitch overrides
// whatever type it otherwise would have been); it's pre-selected whenever
// is_star_pitch was already set elsewhere (e.g. the live scorebook's STAR
// PITCH toggle).
const STAR_PITCH_OPTION = { value: 'star', label: 'Star Pitch' }

// Compact override for the video-clock mark buttons (Mark Contact/Landed/
// Fielded/clip bounds) — the global .ghost-button padding/font-size is sized
// for normal nav-style buttons and wraps this row onto a second line once
// three or four of these (each with a timestamp suffix) are showing at once.
const MARK_BUTTON_BASE_STYLE = { fontSize: 12, padding: '5px 10px', gap: '0.3rem', whiteSpace: 'nowrap' }
// Same state coloring, sized to match the existing compact pitch-type row.
const PITCH_BUTTON_BASE_STYLE = { fontSize: 11, padding: '4px 8px' }

// Green/filled once a value is recorded (a video-clock mark, a pitch type
// pick), dashed amber outline while still needed — a glance at the row
// should tell you what's left to fill in without reading each label/suffix.
function markButtonStyle(isSet, baseStyle = MARK_BUTTON_BASE_STYLE) {
  return isSet
    ? { ...baseStyle, background: 'rgba(74,222,128,0.16)', borderColor: 'var(--success)', color: 'var(--success)', fontWeight: 700 }
    : { ...baseStyle, borderStyle: 'dashed', borderColor: 'var(--gold)', color: 'var(--gold)' }
}

// Every field this panel can edit for the current at-bat — compared against
// the saved PA to detect unsaved changes (hit/fielded location, trajectory,
// distance/hang time/exit velo/launch angle, contact/fielded marks, and the
// clip start/end timestamps all count).
const DIRTY_CHECK_FIELDS = [
  'trajectory', 'hit_x', 'hit_y', 'hit_distance_ft', 'hit_angle_deg',
  'hang_time_sec', 'exit_velocity_mph', 'launch_angle_deg',
  'contact_video_sec', 'landed_video_sec', 'fielded_video_sec',
  'video_timestamp_start_sec', 'video_timestamp_end_sec',
  'fielded_x', 'fielded_y', 'is_robbed_hr',
]

function Field({ label, children }) {
  return (
    <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
      <span className="muted" style={{ textTransform: 'uppercase', fontWeight: 700, fontSize: 10, letterSpacing: '.05em' }}>{label}</span>
      {children}
    </label>
  )
}

// Embedded in Scorebook's "At-Bat Data" tab (formerly the manual-entry-only
// Exit Velocity tab). Fully controlled by the parent — game/pas/characters/
// stadiumKey are already loaded there, and onSave delegates the actual
// write to Scorebook's own (pa, patch) => update callback so its
// plateAppearances state stays in sync everywhere else it's read (spray
// charts, the Admin tab's PA list, etc.) without this component needing its
// own copy of that state.
const AtBatDataEntryPanel = forwardRef(function AtBatDataEntryPanel({ game, pas, pitches, charactersById, stadiumKey, atBatSource, onSave, onSavePitchType, onDirtyChange }, ref) {
  const { pushToast } = useToast()
  const clipPlayerRef = useRef(null)

  // Every plate appearance, not just balls in play — pitch type/star pitch
  // (the Pitches column) applies to every pitch thrown, including strikeouts
  // and walks that never became a batted ball. The hit-location/trajectory/
  // exit-velocity section below is still gated to batted balls specifically
  // (see isBattedBallPa), since none of that applies to a K/BB/HBP.
  const rows = pas

  const [currentIndex, setCurrentIndex] = useState(0)
  const [draftState, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const [editingClipBounds, setEditingClipBounds] = useState(false)

  const currentPa = rows[currentIndex] || null
  const videoId = game?.video_url ? extractYouTubeId(game.video_url) : null
  const currentPaPitches = currentPa
    ? (pitches || []).filter((p) => p.pa_id === currentPa.id).sort((a, b) => (a.pitch_number_pa ?? 0) - (b.pitch_number_pa ?? 0))
    : []
  const [savingPitchId, setSavingPitchId] = useState(null)

  async function handlePitchTypeSelect(pitch, value) {
    const currentValue = pitch.is_star_pitch ? 'star' : pitch.pitch_type
    const nextValue = currentValue === value ? null : value
    const patch = nextValue === 'star'
      ? { pitch_type: null, is_star_pitch: true }
      : { pitch_type: nextValue, is_star_pitch: false }
    setSavingPitchId(pitch.id)
    await onSavePitchType?.(pitch.id, patch)
    setSavingPitchId(null)
  }

  // Reset draft synchronously (during render, not in an effect) whenever the
  // current PA changes. An effect-based reset lands one render late — the
  // video's key would already reflect the new at-bat's id while draft (and
  // therefore its start/end clip bounds) still belonged to the previous one,
  // so the player briefly mounts with the wrong clip and, since nothing
  // changes its key again afterward, gets stuck showing it.
  const lastPaIdRef = useRef(undefined)
  let draft = draftState
  if (currentPa?.id !== lastPaIdRef.current) {
    lastPaIdRef.current = currentPa?.id
    draft = currentPa
    setDraft(currentPa)
    if (editingClipBounds) setEditingClipBounds(false)
  }

  useEffect(() => {
    setCurrentIndex(0)
  }, [game?.id])

  // Unsaved-changes detection for Scorebook's leave-page guard — every field
  // this panel can touch for the current at-bat, compared against the saved
  // PA. Hooks run unconditionally (before the early returns below), same as
  // everything else here.
  const isDirty = Boolean(currentPa && draft && DIRTY_CHECK_FIELDS.some((field) => draft[field] !== currentPa[field]))

  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])

  // Prev/Next just swap currentIndex, which the render-time reset above
  // silently overwrites draft in response to — nothing else guards that, so
  // it needs its own local confirmation (leaving the page/tab is handled by
  // Scorebook via onDirtyChange, but moving to a different at-bat within
  // this same panel never leaves the page).
  const { run: runIndexChange, blocker: indexChangeBlocker } = useConfirmedAction(isDirty)

  useImperativeHandle(ref, () => ({
    save: () => saveCurrent(false),
    discard: () => setDraft(currentPa),
  }))

  if (!rows.length) {
    return <div className="muted" style={{ fontSize: 13 }}>No at-bats recorded for this game.</div>
  }
  if (!draft) return null

  // Whether this at-bat's video clip is bounded yet — driven by the draft
  // (not the saved PA) so setting both marks below flips straight into the
  // clip-scoped contact/fielded workflow without requiring a save first.
  const hasClipBounds = draft.video_timestamp_start_sec != null && draft.video_timestamp_end_sec != null
  // Editing already-set bounds reuses the same capture UI as setting them
  // for the first time — "editingClipBounds" just forces that view even
  // though hasClipBounds is true.
  const showClipCapture = !hasClipBounds || editingClipBounds

  // At-bats are back-to-back in the broadcast, so the previous at-bat's end
  // mark is a good starting scrub point for this one — saves re-hunting
  // through the video for where the next at-bat picks up. Only kicks in when
  // this at-bat has no bounds of its own yet (a fresh, unmarked clip);
  // re-editing existing bounds should keep opening at its own start instead.
  const previousClipEndSec = rows[currentIndex - 1]?.video_timestamp_end_sec ?? null
  const clipCaptureStartSec = !hasClipBounds && previousClipEndSec != null ? previousClipEndSec : undefined

  function clearClipBounds() {
    setDraft((d) => ({ ...d, video_timestamp_start_sec: null, video_timestamp_end_sec: null }))
    setEditingClipBounds(false)
  }

  // Exit velocity/launch angle always come from hit_distance_ft (the landed
  // spot) and hang_time_sec (contact_video_sec -> landed_video_sec) — same
  // rule for every trajectory, grounders included. landed_video_sec means
  // "first touches the ground" uniformly now (the game renders its own
  // on-screen marker for that moment, so it's precise even for a grounder's
  // brief hop), so contact-to-landed is always a real, matching-endpoint
  // distance/time pair to feed the projectile solver. fielded_x/y and
  // fielded_video_sec (wherever/whenever it was actually secured, if that
  // differs from landed) never feed this — they're read by fieldingRange.js
  // for Range Runs only. Mixing fielding circumstances into distance/time
  // here would divide one point's distance by a different point's elapsed
  // time and produce a physically meaningless number.
  //
  // The one exception is a robbed home run (is_robbed_hr) — there,
  // hit_distance_ft is deliberately truncated (it's where the fielder
  // caught it, short of the fence the ball was still carrying toward), so
  // exitVelocityDistanceFt substitutes the assumed true distance instead,
  // without touching the stored hit_distance_ft itself (which stays the
  // real catch spot, for the field diagram/spray charts).
  function computeShotShapeEstimate(next) {
    if (next.hang_time_sec != null) {
      const config = stadiumKey ? STADIUM_CONFIGS[stadiumKey] : null
      const distanceFt = exitVelocityDistanceFt({
        isRobbedHr: next.is_robbed_hr,
        hitDistanceFt: next.hit_distance_ft,
        hitAngleDeg: next.hit_angle_deg,
      }, config)
      return estimateExitVelocity(distanceFt, next.hang_time_sec)
    }
    return null
  }

  function applyShotShapeEstimate(next) {
    const estimate = computeShotShapeEstimate(next)
    return {
      ...next,
      exit_velocity_mph: estimate?.exitVelocityMph ?? null,
      launch_angle_deg: estimate?.launchAngleDeg ?? null,
    }
  }

  function recomputeShotShape(patch) {
    setDraft((d) => applyShotShapeEstimate({ ...d, ...patch }))
  }

  function handleFieldTap(spot) {
    const config = stadiumKey ? STADIUM_CONFIGS[stadiumKey] : null
    recomputeShotShape({
      hit_x: spot.x,
      hit_y: spot.y,
      hit_distance_ft: config ? estimateHitDistance(spot, config) : null,
      hit_angle_deg: config ? estimateHitAngle(spot, config) : null,
    })
  }

  // Where the ball was actually secured, separate from hit_x/hit_y — always
  // purely positional now (see computeShotShapeEstimate above for why it
  // never feeds exit velocity/launch angle for any trajectory). Feeds
  // fieldingRange.js's Range Runs instead, paired with fielded_video_sec
  // (markFieldedTime below) for a real elapsed time when that's marked too.
  function handleFieldedTap(spot) {
    setDraft((d) => ({ ...d, fielded_x: spot.x, fielded_y: spot.y }))
  }

  // Beginning/end-of-at-bat marks, read from the full (unbounded) video
  // player while no clip exists yet for this PA — same getCurrentTime()
  // mechanic as the contact/fielded marks below, just against the full
  // broadcast instead of an already-clipped scrubber. 2-decimal rounding
  // matches video_timestamp_start_sec/end_sec's existing column precision
  // (set on the Video Timestamps page, which this replicates inline here).
  function markClipBound(field) {
    const current = clipPlayerRef.current?.getCurrentTime?.()
    if (current == null) {
      pushToast({ title: 'Video not ready', type: 'error' })
      return
    }
    const seconds = Math.round(current * 100) / 100
    setDraft((d) => ({ ...d, [field]: seconds }))
  }

  // Contact/landed marks are read from the clip-bounded player (scoped to
  // this PA's own start/end range) — getCurrentTime() reports a live float
  // whether the clip is playing or paused, so either works. 3-decimal
  // rounding (milliseconds) since the subtraction below is where rounding
  // error would otherwise compound.
  function markHangTime(field) {
    const current = clipPlayerRef.current?.getCurrentTime?.()
    if (current == null) {
      pushToast({ title: 'Video not ready', type: 'error' })
      return
    }
    const seconds = Math.round(current * 1000) / 1000
    setDraft((d) => {
      const next = { ...d, [field]: seconds }
      const hangTimeSec = next.contact_video_sec != null && next.landed_video_sec != null
        ? Math.round((next.landed_video_sec - next.contact_video_sec) * 1000) / 1000
        : next.hang_time_sec
      return applyShotShapeEstimate({ ...next, hang_time_sec: hangTimeSec })
    })
  }

  // When the ball lands and is retrieved from somewhere other than where it
  // landed (a gapper that rolls, a bobbled/relayed catch), landed_video_sec
  // only captures the landing moment — this is the separate moment a fielder
  // actually got to it. Doesn't feed the shot-shape estimate (that's already
  // fixed by contact/landed), just gives fieldingRange.js a real elapsed time
  // for these plays instead of falling back to a distance-only signal.
  function markFieldedTime() {
    const current = clipPlayerRef.current?.getCurrentTime?.()
    if (current == null) {
      pushToast({ title: 'Video not ready', type: 'error' })
      return
    }
    const seconds = Math.round(current * 1000) / 1000
    setDraft((d) => ({ ...d, fielded_video_sec: seconds }))
  }

  async function saveCurrent(advance) {
    if (!draft || !currentPa) return
    const payload = {
      trajectory: draft.trajectory,
      hit_x: draft.hit_x,
      hit_y: draft.hit_y,
      hit_distance_ft: draft.hit_distance_ft,
      hit_angle_deg: draft.hit_angle_deg,
      hit_stadium_key: draft.hit_x != null ? stadiumKey : draft.hit_stadium_key,
      hang_time_sec: draft.hang_time_sec,
      contact_video_sec: draft.contact_video_sec ?? null,
      landed_video_sec: draft.landed_video_sec ?? null,
      fielded_video_sec: draft.fielded_video_sec ?? null,
      video_timestamp_start_sec: draft.video_timestamp_start_sec ?? null,
      video_timestamp_end_sec: draft.video_timestamp_end_sec ?? null,
      fielded_x: draft.fielded_x ?? null,
      fielded_y: draft.fielded_y ?? null,
      is_robbed_hr: Boolean(draft.is_robbed_hr),
      exit_velocity_mph: draft.exit_velocity_mph,
      launch_angle_deg: draft.launch_angle_deg,
      // Older Buddy Jumps were recorded before their FO/LO shape was known,
      // so keep resolving those once a trajectory is entered. A Buddy Jump
      // recorded on a sacrifice fly must remain an SF, though, or this later
      // data-entry pass would silently remove the batter's sacrifice credit.
      ...(currentPa.is_buddy_jump && draft.trajectory ? {
        result: currentPa.result === 'SF' ? 'SF' : (draft.trajectory === 'L' ? 'LO' : 'FO'),
        hit_notation: assembleNotation(draft.trajectory, [currentPa.buddy_jump_assist_position, currentPa.buddy_jump_putout_position].filter(Boolean)),
      } : {}),
    }
    setSaving(true)
    await onSave(currentPa, payload)
    setSaving(false)
    if (advance && currentIndex < rows.length - 1) setCurrentIndex((i) => i + 1)
  }

  const batterName = currentPa ? (charactersById[currentPa.character_id]?.name || 'Unknown batter') : ''
  // Hit location/trajectory/exit velocity only ever apply to an at-bat that
  // actually put the ball in play — same condition `rows` used to be
  // filtered down to before pitch type made every at-bat show up here.
  const isBattedBallPa = battedBallResults.has(currentPa.result) || Boolean(currentPa.is_buddy_jump)
  const showFieldedMap = shouldShowFieldedLocation(draft)
  // Geometry-only suggestion (same margin Scorebook's live Buddy Jump flow
  // uses) shown on the HR Rob toggle before the scorekeeper confirms/
  // corrects it — never applied automatically.
  const autoRobbedHr = (() => {
    const config = stadiumKey ? STADIUM_CONFIGS[stadiumKey] : null
    if (!config || draft.hit_distance_ft == null || draft.hit_angle_deg == null) return false
    const wallDistanceFt = estimateWallDistanceAtAngle(draft.hit_angle_deg, config)
    return wallDistanceFt != null && draft.hit_distance_ft >= wallDistanceFt - ROBBED_HR_WALL_MARGIN_FT
  })()

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800 }}>{batterName}</h3>
          <div className="muted" style={{ fontSize: 12 }}>
            Inning {currentPa.inning} · {formatPaResultLabel(currentPa)} · At-bat {currentIndex + 1} of {rows.length}
          </div>
        </div>
        {atBatSource ? (
          <Link
            to={`/at-bat/${atBatSource}/${currentPa.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="ghost-button"
            style={{ textDecoration: 'none' }}
            onClick={(event) => {
              // Opens in a new tab, so this page's own unsaved-changes route
              // guard never fires for it (nothing here actually navigates
              // away) — without this, unsaved edits could look "saved" from
              // this tab while you're off correcting something in the other
              // one, then get silently discarded once you come back and
              // leave. Route it through the same confirm-or-discard prompt
              // Previous/Next already use instead.
              if (!isDirty) return
              event.preventDefault()
              runIndexChange(() => window.open(`/at-bat/${atBatSource}/${currentPa.id}`, '_blank', 'noopener,noreferrer'))
            }}
          >
            Edit At-Bat
          </Link>
        ) : null}
      </div>

      <div style={{
        display: 'grid',
        gridTemplateColumns: isBattedBallPa
          ? 'minmax(300px, 460px) minmax(400px, 700px) minmax(260px, 360px)'
          : 'minmax(400px, 700px) minmax(260px, 360px)',
        gap: 16,
        alignItems: 'start',
      }}>
        {isBattedBallPa ? (
        <div style={{ flex: '1 1 360px', minWidth: 300, maxWidth: 460, margin: '0 auto', display: 'grid', gap: 10 }}>
          <FieldPlayBuilder
            landingSpot={draft.hit_x != null && draft.hit_y != null ? { x: draft.hit_x, y: draft.hit_y } : null}
            onFieldTap={handleFieldTap}
            secondarySpot={
              showFieldedMap && draft.fielded_x != null && draft.fielded_y != null ? { x: draft.fielded_x, y: draft.fielded_y } : null
            }
            onSecondaryTap={showFieldedMap ? handleFieldedTap : undefined}
            allowFielderSelection={false}
            showFielderMarkers={false}
            label="Hit / Fielded location"
            stadiumKey={stadiumKey}
          />

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <Field label="Trajectory">
              <select
                value={draft.trajectory || ''}
                onChange={(e) => recomputeShotShape({ trajectory: e.target.value || null })}
              >
                <option value="">—</option>
                {TRAJECTORY_OPTIONS.map((opt) => (
                  <option key={opt} value={opt} disabled={currentPa.is_buddy_jump && opt === 'G'}>{opt}</option>
                ))}
              </select>
            </Field>
            <Field label="Hit distance (ft)">
              <input type="number" step="1" value={draft.hit_distance_ft ?? ''} onChange={(e) => recomputeShotShape({ hit_distance_ft: e.target.value === '' ? null : Number(e.target.value) })} style={{ width: 90 }} />
            </Field>
            <Field label="Hang time (sec)">
              <input type="number" step="0.001" value={draft.hang_time_sec ?? ''} onChange={(e) => recomputeShotShape({ hang_time_sec: e.target.value === '' ? null : Number(e.target.value) })} style={{ width: 90 }} />
            </Field>
            <Field label="Exit velocity (mph)">
              <div style={{ width: 90, padding: '4px 0' }}>{draft.exit_velocity_mph ?? '—'}</div>
            </Field>
            <Field label="Launch angle (deg)">
              <div style={{ width: 90, padding: '4px 0' }}>{draft.launch_angle_deg ?? '—'}</div>
            </Field>
            {draft.trajectory && draft.trajectory !== 'G' ? (
              <Field label="HR Rob">
                <button
                  type="button"
                  className="ghost-button"
                  onClick={() => recomputeShotShape({ is_robbed_hr: !draft.is_robbed_hr })}
                  title={
                    draft.is_robbed_hr
                      ? 'Marked as a robbed home run — exit velocity/launch angle use the wall distance + assumed carry instead of the truncated catch-spot distance.'
                      : autoRobbedHr
                        ? 'Caught within range of the wall — looks like it might have been a robbed home run. Tap to mark it.'
                        : 'Tap if this catch robbed a home run — the catch spot understates true distance for a robbed HR.'
                  }
                  style={markButtonStyle(Boolean(draft.is_robbed_hr), PITCH_BUTTON_BASE_STYLE)}
                >
                  {draft.is_robbed_hr ? 'ROBBED' : autoRobbedHr ? 'ROB?' : 'Not a rob'}
                </button>
              </Field>
            ) : null}
          </div>
        </div>
        ) : null}

        <div style={{ display: 'grid', gap: 6 }}>
          {videoId ? (
            <YouTubePlayer
              key={`${currentPa.id}-${showClipCapture ? 'full' : 'clip'}-${clipCaptureStartSec ?? ''}`}
              ref={clipPlayerRef}
              videoId={videoId}
              startSec={showClipCapture ? clipCaptureStartSec : draft.video_timestamp_start_sec}
              endSec={showClipCapture ? undefined : draft.video_timestamp_end_sec}
            />
          ) : (
            <div className="muted" style={{ fontSize: 12 }}>No video linked to this game.</div>
          )}
          {showClipCapture && videoId ? (
            <div className="muted" style={{ fontSize: 11 }}>
              {hasClipBounds ? 'Re-scrub to where this at-bat starts/ends and mark both below.' : 'No clip set for this at-bat yet — scrub to where it starts/ends and mark both below.'}
            </div>
          ) : null}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {showClipCapture ? (
              <>
                <button type="button" className="ghost-button" disabled={!videoId} onClick={() => markClipBound('video_timestamp_start_sec')} style={markButtonStyle(draft.video_timestamp_start_sec != null)}>
                  Beginning of At-Bat{draft.video_timestamp_start_sec != null ? ` (${Number(draft.video_timestamp_start_sec).toFixed(2)}s)` : ''}
                </button>
                <button type="button" className="ghost-button" disabled={!videoId} onClick={() => markClipBound('video_timestamp_end_sec')} style={markButtonStyle(draft.video_timestamp_end_sec != null)}>
                  End of At-Bat{draft.video_timestamp_end_sec != null ? ` (${Number(draft.video_timestamp_end_sec).toFixed(2)}s)` : ''}
                </button>
                {hasClipBounds ? (
                  <button type="button" className="ghost-button" onClick={() => setEditingClipBounds(false)} style={MARK_BUTTON_BASE_STYLE}>Done editing</button>
                ) : null}
                {(draft.video_timestamp_start_sec != null || draft.video_timestamp_end_sec != null) ? (
                  <button type="button" className="ghost-button" onClick={clearClipBounds} style={MARK_BUTTON_BASE_STYLE}>Clear timestamps</button>
                ) : null}
              </>
            ) : (
              <>
                {isBattedBallPa ? (
                  <>
                    <button type="button" className="ghost-button" disabled={!videoId} onClick={() => markHangTime('contact_video_sec')} style={markButtonStyle(draft.contact_video_sec != null)}>
                      Mark Contact{draft.contact_video_sec != null ? ` (${Number(draft.contact_video_sec).toFixed(3)}s)` : ''}
                    </button>
                    <button type="button" className="ghost-button" disabled={!videoId} onClick={() => markHangTime('landed_video_sec')} style={markButtonStyle(draft.landed_video_sec != null)}>
                      Mark Landed{draft.landed_video_sec != null ? ` (${Number(draft.landed_video_sec).toFixed(3)}s)` : ''}
                    </button>
                    {showFieldedMap ? (
                      <button type="button" className="ghost-button" disabled={!videoId} onClick={markFieldedTime} style={markButtonStyle(draft.fielded_video_sec != null)}>
                        Mark Fielded{draft.fielded_video_sec != null ? ` (${Number(draft.fielded_video_sec).toFixed(3)}s)` : ''}
                      </button>
                    ) : null}
                  </>
                ) : null}
                <button type="button" className="ghost-button" onClick={() => setEditingClipBounds(true)} style={MARK_BUTTON_BASE_STYLE}>Edit start/end</button>
              </>
            )}
          </div>
        </div>

        <div style={{ display: 'grid', gap: 8, alignContent: 'start' }}>
          <span className="muted" style={{ textTransform: 'uppercase', fontWeight: 700, fontSize: 10, letterSpacing: '.05em' }}>Pitches</span>
          {currentPaPitches.length === 0 ? (
            <div className="muted" style={{ fontSize: 12 }}>No pitches recorded for this at-bat.</div>
          ) : (
            currentPaPitches.map((pitch) => (
              <div key={pitch.id} style={{ display: 'grid', gap: 6, padding: 8, borderRadius: 8, border: '1px solid var(--border, rgba(148,163,184,0.2))' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                  <span>#{pitch.pitch_number_pa}</span>
                  <span className="muted">
                    {pitch.result === 'in_play' ? `In Play (${formatPaResultLabel(currentPa)})` : formatPitchResultLabel(pitch.result)}
                  </span>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {(() => {
                    const hasPitchType = Boolean(pitch.pitch_type) || Boolean(pitch.is_star_pitch)
                    return [...PITCH_TYPE_OPTIONS, STAR_PITCH_OPTION].map((option) => {
                      const selected = option.value === 'star' ? Boolean(pitch.is_star_pitch) : (!pitch.is_star_pitch && pitch.pitch_type === option.value)
                      // Selected option always reads as "set" (green); every
                      // option reads as "still needs a pick" (dashed amber)
                      // until one is chosen, then the rest go neutral.
                      const style = selected
                        ? markButtonStyle(true, PITCH_BUTTON_BASE_STYLE)
                        : hasPitchType ? PITCH_BUTTON_BASE_STYLE : markButtonStyle(false, PITCH_BUTTON_BASE_STYLE)
                      return (
                        <button
                          key={option.value}
                          type="button"
                          disabled={savingPitchId === pitch.id}
                          onClick={() => handlePitchTypeSelect(pitch, option.value)}
                          className="ghost-button"
                          style={style}
                        >
                          {option.label}
                        </button>
                      )
                    })
                  })()}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="ghost-button" disabled={saving} onClick={() => saveCurrent(false)}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="primary-button" disabled={saving} onClick={() => saveCurrent(true)}>
            {saving ? 'Saving…' : 'Save & Next'}
          </button>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="ghost-button"
            disabled={currentIndex === 0}
            onClick={() => runIndexChange(() => setCurrentIndex((i) => Math.max(0, i - 1)))}
          >
            ← Previous
          </button>
          <button
            type="button"
            className="ghost-button"
            disabled={currentIndex >= rows.length - 1}
            onClick={() => runIndexChange(() => setCurrentIndex((i) => Math.min(rows.length - 1, i + 1)))}
          >
            Next →
          </button>
        </div>
      </div>

      <UnsavedChangesPrompt
        blocker={indexChangeBlocker}
        onSave={() => saveCurrent(false)}
        message="You have unsaved changes to this at-bat. Save them before moving on, or discard them?"
      />
    </div>
  )
})

export default AtBatDataEntryPanel
