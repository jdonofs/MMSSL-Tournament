import { useCallback, useEffect, useMemo, useState } from 'react'
import FieldPlayBuilder from '../components/FieldPlayBuilder'
import VectorSprayChart from '../components/VectorSprayChart'
import { FEET_PER_UNIT, hasMeasuredGeometry } from '../utils/parkGeometry'
import { formatPaResultLabel, formatPitchResultLabel, parseFielderChainFromNotation } from '../utils/notation'
import { isCreditedHit } from '../utils/creditedHit'
import { getCreditedRbiForPa, hasRispOpportunity, POSITION_LABELS } from '../utils/statsCalculator'

const PREVIEW_URL = 'http://127.0.0.1:4317/state'
const PITCH_DIAGNOSTICS_URL = 'http://127.0.0.1:4317/pitch-diagnostics'
const STADIUM_URL = 'http://127.0.0.1:4317/stadium'

const DISTANCE_SOURCE_LABELS = {
  tracked_endpoint: 'Measured — real tracked landing/catch',
  tracker_last_frame_extrapolation: 'Projected — extrapolated from this shot’s last tracked frame',
  physics_from_exit_velocity: 'Projected — physics from exit velocity + launch angle',
  none: 'No distance available',
}

function Value({ value }) {
  if (value === null || value === undefined || value === '') return <span style={{ color: '#f59e0b' }}>—</span>
  if (typeof value === 'boolean') return <span>{value ? 'true' : 'false'}</span>
  if (typeof value === 'object') return <code style={{ fontSize: 11 }}>{JSON.stringify(value)}</code>
  return <span>{String(value)}</span>
}

function Rows({ object, fields }) {
  return (
    <div>
      {fields.map((field) => (
        <div key={field} style={{ display: 'grid', gridTemplateColumns: 'minmax(175px, 0.8fr) 1.2fr', gap: 10, padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,0.06)', fontSize: 12 }}>
          <code style={{ color: '#94a3b8' }}>{field}</code>
          <Value value={object?.[field]} />
        </div>
      ))}
    </div>
  )
}

function Card({ title, children }) {
  return (
    <section className="panel" style={{ minWidth: 0 }}>
      <h2 style={{ margin: '0 0 10px', fontSize: 14 }}>{title}</h2>
      {children}
    </section>
  )
}

function formatMeasurement(value, unit = '', digits = 1) {
  const number = Number(value)
  if (value === null || value === undefined || !Number.isFinite(number)) return 'Waiting'
  return `${number.toFixed(digits)}${unit ? ` ${unit}` : ''}`
}

function Measurement({ label, value, accent = false }) {
  const waiting = value === 'Waiting'
  return (
    <div style={{
      padding: '12px 14px',
      border: `1px solid ${accent && !waiting ? 'rgba(250, 204, 21, 0.55)' : 'rgba(148, 163, 184, 0.22)'}`,
      borderRadius: 10,
      background: accent && !waiting ? 'rgba(250, 204, 21, 0.08)' : 'rgba(15, 23, 42, 0.45)',
    }}>
      <div style={{ color: '#94a3b8', fontSize: 11, marginBottom: 4 }}>{label}</div>
      <strong style={{ color: waiting ? '#f59e0b' : '#f8fafc', fontSize: 20 }}>{value}</strong>
    </div>
  )
}

// The stat sections below are a completeness check on automatic tracking, so
// they render null as a loud "—" rather than hiding the row: a stat that never
// arrives is exactly what these sections exist to make visible.
function metric(value, unit = '', digits = 1) {
  const number = Number(value)
  if (value === null || value === undefined || value === '' || !Number.isFinite(number)) return null
  return `${number.toFixed(digits)}${unit ? ` ${unit}` : ''}`
}

function Stat({ label, value, accent = false, note = null }) {
  let text = value
  let color = '#f8fafc'
  if (value === null || value === undefined || value === '') { text = '—'; color = '#f59e0b' }
  else if (value === true) { text = 'Yes'; color = '#4ade80' }
  else if (value === false) { text = 'No'; color = '#94a3b8' }
  return (
    <div style={{
      padding: '8px 10px',
      border: `1px solid ${accent ? 'rgba(250, 204, 21, 0.45)' : 'rgba(148, 163, 184, 0.22)'}`,
      borderRadius: 9,
      background: accent ? 'rgba(250, 204, 21, 0.07)' : 'rgba(15, 23, 42, 0.45)',
      minWidth: 0,
    }}>
      <div style={{ color: '#94a3b8', fontSize: 10, letterSpacing: 0.4, textTransform: 'uppercase', marginBottom: 3 }}>{label}</div>
      <strong style={{ color, fontSize: 15, overflowWrap: 'anywhere' }}>{text}</strong>
      {note && <div className="muted" style={{ fontSize: 10, marginTop: 2 }}>{note}</div>}
    </div>
  )
}

function StatGroup({ title, stats, min = 138 }) {
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ color: '#cbd5e1', fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6 }}>
        {title}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: 7 }}>
        {stats.map((stat) => (
          <Stat key={stat.label} label={stat.label} value={stat.value} accent={stat.accent} note={stat.note} />
        ))}
      </div>
    </div>
  )
}

// Just the two arrows. Which at-bat they landed on is already spelled out by
// the matchup strip below them, so there is nothing else to say here.
function AtBatArrows({ atBats, selectedPaNumber, onSelect, onFollowLive }) {
  const index = atBats.findIndex((entry) => entry.pa_number === selectedPaNumber)
  const position = index >= 0 ? index : atBats.length - 1
  const step = (delta) => {
    const next = atBats[position + delta]
    if (!next) return
    // Stepping onto the newest at-bat resumes following the live feed, so the
    // page keeps updating itself instead of pinning to what is now the live PA.
    if (position + delta === atBats.length - 1) onFollowLive()
    else onSelect(next.pa_number)
  }
  const buttonStyle = (disabled) => ({
    padding: '5px 13px', borderRadius: 8, fontSize: 16, fontWeight: 800, lineHeight: 1.2,
    cursor: disabled ? 'default' : 'pointer',
    background: disabled ? 'rgba(148, 163, 184, 0.06)' : 'rgba(250, 204, 21, 0.12)',
    color: disabled ? '#475569' : '#fde047',
    border: `1px solid ${disabled ? 'rgba(148, 163, 184, 0.2)' : 'rgba(250, 204, 21, 0.5)'}`,
  })
  return (
    <div style={{ display: 'flex', gap: 7 }}>
      <button
        type="button"
        title="Previous at-bat"
        onClick={() => step(-1)}
        disabled={position <= 0}
        style={buttonStyle(position <= 0)}
      >←</button>
      <button
        type="button"
        title="Next at-bat"
        onClick={() => step(1)}
        disabled={position >= atBats.length - 1}
        style={buttonStyle(position >= atBats.length - 1)}
      >→</button>
    </div>
  )
}

function PitchTelemetry({ pitch }) {
  const telemetry = pitch.pitch_telemetry
  if (!telemetry) return <p className="muted" style={{ margin: '7px 0 0' }}>Waiting for pitch-flight telemetry.</p>
  return (
    <div style={{ marginTop: 8, display: 'grid', gap: 8 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 7 }}>
        <Measurement label="Measured speed" value={formatMeasurement(telemetry.speedMph, 'mph')} accent />
        <Measurement label="Travel time" value={formatMeasurement(telemetry.elapsedSeconds, 'sec', 3)} />
        <Measurement label="Path distance" value={formatMeasurement(telemetry.pathDistanceFeet, 'ft')} />
        <Measurement label="XYZ samples" value={telemetry.sampleCount ?? 'Waiting'} />
      </div>
      <Rows object={{
        status: telemetry.status,
        terminal: telemetry.terminal,
        start_sequence: telemetry.startSeq,
        end_sequence: telemetry.endSeq,
        horizontal_delta_units: telemetry.horizontalDeltaUnits,
        vertical_delta_units: telemetry.verticalDeltaUnits,
        forward_delta_units: telemetry.forwardDeltaUnits,
        horizontal_chord_deviation_units: telemetry.horizontalChordDeviationUnits,
        vertical_chord_deviation_units: telemetry.verticalChordDeviationUnits,
        start_xyz: telemetry.start,
        end_xyz: telemetry.end,
      }} fields={[
        'status', 'terminal', 'start_sequence', 'end_sequence',
        'horizontal_delta_units', 'vertical_delta_units', 'forward_delta_units',
        'horizontal_chord_deviation_units', 'vertical_chord_deviation_units',
        'start_xyz', 'end_xyz',
      ]} />
      <details>
        <summary style={{ cursor: 'pointer', color: '#cbd5e1', fontSize: 11 }}>
          Raw XYZ sequence ({telemetry.samples?.length || 0} samples)
        </summary>
        <pre style={{ margin: '7px 0 0', maxHeight: 230, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 10, color: '#94a3b8' }}>
          {JSON.stringify(telemetry.samples || [], null, 2)}
        </pre>
      </details>
    </div>
  )
}

const TOTAL_BASES_BY_RESULT = { '1B': 1, '2B': 2, '3B': 3, HR: 4, IPHR: 4 }
const TRAJECTORY_LABELS = { G: 'Ground ball (G)', L: 'Line drive (L)', F: 'Fly ball (F)', B: 'Bunt (B)' }
const STRIKEOUT_TYPE_LABELS = { KS: 'Swinging (KS)', KL: 'Looking (KL)' }
const SPRAY_SIDE_LABELS = { third_base: 'Left (3B side)', center: 'Center', first_base: 'Right (1B side)' }
const BATTER_OUT_RESULTS = new Set(['K', 'GO', 'FO', 'LO', 'DP', 'TP', 'SF', 'SH'])
// Mirrors recomputePitchingStatsForGame in scripts/live_tracker_bridge.mjs — a
// strike is every pitch row that is not a ball and not a hit batsman.
const BALL_PITCH_RESULTS = new Set(['ball', 'hbp'])

function positionLabel(position) {
  if (position == null) return null
  return `${position}${POSITION_LABELS[position] ? ` (${POSITION_LABELS[position]})` : ''}`
}

function nameList(names) {
  const clean = (names || []).filter(Boolean)
  return clean.length ? clean.join(', ') : null
}

function BattingStats({ pa, contact }) {
  const creditedHit = isCreditedHit(pa)
  const result = pa.result || null
  const runsOnPlay = pa.runs_scored || []
  return (
    <Card title="Batting — every at-bat stat tracked">
      <StatGroup title="Result and scoring" stats={[
        { label: 'Result', value: result ? formatPaResultLabel(pa) : null, accent: true },
        { label: 'Result code', value: result },
        { label: 'Credited hit', value: result ? creditedHit : null },
        { label: 'Hit type', value: creditedHit ? result : null },
        { label: 'Total bases', value: result ? (creditedHit ? TOTAL_BASES_BY_RESULT[result] ?? 0 : 0) : null },
        { label: 'Official at-bat', value: pa.is_official_ab },
        { label: 'RBI (recorded)', value: pa.rbi, accent: true },
        { label: 'RBI (credited)', value: result ? getCreditedRbiForPa(pa) : null, note: 'errors/DP/TP/FC credit 0' },
        { label: 'Batter scored', value: pa.run_scored },
        { label: 'Runs on play', value: runsOnPlay.length },
        { label: 'Earned run', value: pa.is_earned_run },
        { label: 'Outs on play', value: pa.outs_on_play },
        { label: 'Batter retired', value: result ? BATTER_OUT_RESULTS.has(result) : null },
        { label: 'Strikeout', value: result ? result === 'K' : null },
        { label: 'Strikeout type', value: STRIKEOUT_TYPE_LABELS[pa.strikeout_type] || pa.strikeout_type },
        { label: 'Walk', value: result ? result === 'BB' : null },
        { label: 'Hit by pitch', value: result ? result === 'HBP' : null },
        { label: 'Sacrifice fly', value: result ? result === 'SF' : null },
        { label: 'Sacrifice bunt', value: result ? result === 'SH' : null },
        { label: 'Bunt', value: pa.trajectory ? Boolean(pa.is_bunt) : null },
        { label: 'Bunt hit', value: pa.trajectory ? Boolean(pa.is_bunt) && creditedHit : null },
        { label: 'Reached on error', value: pa.is_error },
        { label: "Fielder's choice", value: pa.fielder_choice_out },
      ]} />
      <StatGroup title="Batted-ball measurements" stats={[
        { label: 'Exit velocity', value: metric(pa.exit_velocity_mph, 'mph'), accent: true },
        { label: 'Launch angle', value: metric(pa.launch_angle_deg, 'deg'), accent: true },
        { label: 'Hit distance', value: metric(pa.hit_distance_ft, 'ft'), accent: true },
        { label: 'Spray angle', value: metric(pa.hit_angle_deg, 'deg'), accent: true },
        { label: 'Hang time', value: metric(pa.hang_time_sec, 'sec', 2) },
        { label: 'Trajectory', value: TRAJECTORY_LABELS[pa.trajectory] || pa.trajectory },
        { label: 'Spray side', value: SPRAY_SIDE_LABELS[contact?.spraySide] || contact?.spraySide },
        { label: 'Endpoint', value: contact?.endpoint },
        { label: 'Endpoint status', value: contact?.endpointStatus },
        { label: 'Distance source', value: pa.preview_projection?.distance_source },
        { label: 'Star swing used', value: pa.star_hit_used },
        { label: 'Stadium', value: pa.hit_stadium_key },
      ]} />
      <StatGroup title="Situation" stats={[
        { label: 'PA number', value: pa.pa_number },
        { label: 'Inning', value: `${pa.half} ${pa.inning}` },
        { label: 'Batter', value: pa.batter_name },
        { label: 'Pitches seen', value: pa.pitches?.length ?? 0 },
        { label: 'Runner on 1st', value: pa.runner_on_first_before },
        { label: 'Runner on 2nd', value: pa.runner_on_second_before },
        { label: 'Runner on 3rd', value: pa.runner_on_third_before },
        { label: 'RISP chance', value: hasRispOpportunity(pa) },
        { label: 'Runners resolved', value: pa.runner_assignments ? pa.runner_assignments.length : null, note: 'exact base-by-base' },
      ]} />
    </Card>
  )
}

function PitchingStats({ pa }) {
  const pitches = pa.pitches || []
  const result = pa.result || null
  // Number(null) is 0, and a pitch whose flight was never measured carries a
  // null speed — averaging those in as 0 mph would halve the reported velocity.
  const speeds = pitches
    .filter((pitch) => pitch.pitch_speed_mph !== null && pitch.pitch_speed_mph !== undefined && pitch.pitch_speed_mph !== '')
    .map((pitch) => Number(pitch.pitch_speed_mph))
    .filter(Number.isFinite)
  const firstPitch = pitches.find((pitch) => pitch.count_balls_before === 0 && pitch.count_strikes_before === 0)
  const countBy = (predicate) => pitches.filter(predicate).length
  const typeCount = (type) => countBy((pitch) => pitch.pitch_type === type)
  const runsOnPlay = pa.runs_scored || []
  const creditedHit = isCreditedHit(pa)
  const outs = Number(pa.outs_on_play || 0)
  return (
    <Card title="Pitching — every at-bat stat tracked">
      <StatGroup title="Line charged to the pitcher" stats={[
        { label: 'Pitcher', value: pa.pitcher_name, accent: true },
        { label: 'Batter faced', value: result ? 1 : null },
        { label: 'Outs recorded', value: pa.outs_on_play },
        { label: 'Innings pitched', value: result ? Number(`${Math.floor(outs / 3)}.${outs % 3}`) : null },
        { label: 'Strikeout', value: result ? result === 'K' : null },
        { label: 'Walk allowed', value: result ? result === 'BB' : null },
        { label: 'Hit batsman', value: result ? result === 'HBP' : null },
        { label: 'Hit allowed', value: result ? creditedHit : null },
        { label: 'Home run allowed', value: result ? creditedHit && (result === 'HR' || result === 'IPHR') : null },
        { label: 'Runs allowed', value: runsOnPlay.length },
        { label: 'Earned runs', value: runsOnPlay.filter((run) => run.is_earned_run).length },
        { label: 'Unearned runs', value: runsOnPlay.filter((run) => !run.is_earned_run).length },
      ]} />
      <StatGroup title="Pitch counts" stats={[
        { label: 'Pitches thrown', value: pitches.length, accent: true },
        { label: 'Strikes thrown', value: countBy((pitch) => !BALL_PITCH_RESULTS.has(pitch.result)) },
        { label: 'Balls thrown', value: countBy((pitch) => pitch.result === 'ball') },
        { label: 'Strike rate', value: pitches.length ? `${Math.round((countBy((pitch) => !BALL_PITCH_RESULTS.has(pitch.result)) / pitches.length) * 100)}%` : null },
        { label: 'First-pitch strike', value: firstPitch ? !BALL_PITCH_RESULTS.has(firstPitch.result) : null },
        { label: 'Called strikes', value: countBy((pitch) => pitch.result === 'looking') },
        { label: 'Swinging misses', value: countBy((pitch) => pitch.result === 'swinging_miss') },
        { label: 'Unknown-swing strikes', value: countBy((pitch) => pitch.result === 'strike_unknown') },
        { label: 'Fouls', value: countBy((pitch) => pitch.result === 'foul') },
        { label: 'Balls in play', value: countBy((pitch) => pitch.result === 'in_play') },
      ]} />
      <StatGroup title="Pitch mix and velocity" stats={[
        { label: 'Fastballs', value: typeCount('fastball') },
        { label: 'Curveballs', value: typeCount('curveball') },
        { label: 'Changeups', value: typeCount('changeup') },
        { label: 'Unclassified', value: countBy((pitch) => !pitch.pitch_type) },
        { label: 'Avg pitch speed', value: speeds.length ? metric(speeds.reduce((total, value) => total + value, 0) / speeds.length, 'mph') : null },
        { label: 'Top pitch speed', value: speeds.length ? metric(Math.max(...speeds), 'mph') : null },
        { label: 'Star pitches thrown', value: countBy((pitch) => pitch.is_star_pitch) },
        { label: 'Star pitch used', value: pa.star_pitch_used },
        { label: 'Star pitch successful', value: pa.star_pitch_successful },
      ]} />
      <div style={{ marginTop: 12 }}>
        <div style={{ color: '#cbd5e1', fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6 }}>
          Per-pitch stat rows
        </div>
        {pitches.length ? (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 520 }}>
              <thead>
                <tr style={{ color: '#94a3b8', textAlign: 'left' }}>
                  {['#', 'Game #', 'Result', 'Type', 'Speed', 'Count', 'Star'].map((heading) => (
                    <th key={heading} style={{ padding: '4px 8px 6px 0', fontWeight: 700 }}>{heading}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pitches.map((pitch) => (
                  <tr key={pitch.pitch_number_pa} style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
                    <td style={{ padding: '5px 8px 5px 0' }}>{pitch.pitch_number_pa}</td>
                    <td style={{ padding: '5px 8px 5px 0', color: '#94a3b8' }}>{pitch.pitch_number_game}</td>
                    <td style={{ padding: '5px 8px 5px 0' }}>{formatPitchResultLabel(pitch.result)}</td>
                    <td style={{ padding: '5px 8px 5px 0', color: pitch.pitch_type ? '#f8fafc' : '#f59e0b' }}>{pitch.pitch_type || 'unresolved'}</td>
                    <td style={{ padding: '5px 8px 5px 0' }}>{metric(pitch.pitch_speed_mph, 'mph') || '—'}</td>
                    <td style={{ padding: '5px 8px 5px 0', color: '#94a3b8' }}>
                      {pitch.count_balls_before}-{pitch.count_strikes_before} → {pitch.count_balls_after}-{pitch.count_strikes_after}
                    </td>
                    <td style={{ padding: '5px 8px 5px 0', color: pitch.is_star_pitch ? '#fde047' : '#94a3b8' }}>{pitch.is_star_pitch ? 'STAR' : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted" style={{ margin: 0 }}>No pitches recorded yet.</p>}
      </div>
    </Card>
  )
}

function FieldingStats({ pa, fielded, contact }) {
  const events = pa.fielding_events || {}
  const putouts = events.putouts || []
  const assists = events.assists || []
  const chain = parseFielderChainFromNotation(pa.hit_notation)
  return (
    <Card title="Fielding — every at-bat stat tracked">
      <StatGroup title="Credited fielding" stats={[
        { label: 'Fielding notation', value: pa.hit_notation, accent: true },
        { label: 'Position chain', value: chain.length ? chain.map((position) => positionLabel(Number(position))).join(' → ') : null },
        { label: 'Putouts', value: putouts.length },
        { label: 'Putout fielders', value: nameList(putouts.map((putout) => putout.fielderName)) },
        { label: 'Runners retired', value: nameList(putouts.map((putout) => putout.runnerName)) },
        { label: 'Assists', value: assists.length },
        { label: 'Assist fielders', value: nameList(assists) },
        { label: 'Outs on play', value: pa.outs_on_play },
        { label: 'Double play', value: pa.result ? pa.result === 'DP' : null },
        { label: 'Triple play', value: pa.result ? pa.result === 'TP' : null },
        { label: "Fielder's choice", value: pa.fielder_choice_out },
        { label: 'Hit location', value: positionLabel(pa.hit_location), note: 'not emitted by the tracker' },
      ]} />
      <StatGroup title="Errors and highlight plays" stats={[
        { label: 'Error charged', value: pa.is_error },
        { label: 'Error position', value: positionLabel(pa.error_position) },
        { label: 'Error character', value: pa.error_character },
        { label: 'Error player', value: pa.error_player },
        { label: 'Error notation', value: pa.error_notation },
        { label: 'Bobble', value: events.bobble },
        { label: 'Buddy jump', value: pa.is_buddy_jump },
        { label: 'Buddy jump putout', value: positionLabel(pa.buddy_jump_putout_position) },
        { label: 'Buddy jump assist', value: positionLabel(pa.buddy_jump_assist_position) },
        { label: 'Robbed home run', value: pa.is_robbed_hr },
        { label: 'Nice play', value: pa.is_nice_play, note: 'postgame edit only' },
        { label: 'Caught in the air', value: contact ? contact.endpoint === 'catch' : null },
      ]} />
      <StatGroup title="Fielded-ball measurements" stats={[
        { label: 'Fielded distance', value: metric(fielded?.distanceFeet, 'ft'), accent: true },
        { label: 'Fielded spray angle', value: metric(fielded?.sprayAngleDeg, 'deg'), accent: true },
        { label: 'Time to field', value: metric(fielded?.fieldingTimeSec, 'sec', 2), accent: true },
        { label: 'Measurement source', value: fielded?.source },
        { label: 'Hang time before catch', value: contact?.endpoint === 'catch' ? metric(pa.hang_time_sec, 'sec', 2) : null },
      ]} />
    </Card>
  )
}

function StadiumSelector({ snapshot, onSelect, pending, error }) {
  const options = snapshot?.stadium_options || []
  const detected = snapshot?.stadium_detected_key || null
  const override = snapshot?.stadium_override_key || null
  const effective = snapshot?.stadium_key || null

  return (
    <Card title="Stadium">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <select
          value={override || ''}
          onChange={(event) => onSelect(event.target.value || null)}
          disabled={pending || !options.length}
          style={{
            padding: '7px 10px', borderRadius: 7, fontSize: 12,
            background: 'rgba(15, 23, 42, 0.75)', color: '#f8fafc',
            border: '1px solid rgba(148, 163, 184, 0.35)', minWidth: 210,
          }}
        >
          <option value="">
            {detected ? `Auto — detected ${detected}` : 'Auto — nothing detected yet'}
          </option>
          {options.map((option) => (
            <option key={option.key} value={option.key}>{option.name}</option>
          ))}
        </select>
        {override && (
          <button
            type="button"
            onClick={() => onSelect(null)}
            disabled={pending}
            style={{
              padding: '7px 10px', borderRadius: 7, fontSize: 12, cursor: 'pointer',
              background: 'rgba(148, 163, 184, 0.12)', color: '#cbd5e1',
              border: '1px solid rgba(148, 163, 184, 0.35)',
            }}
          >
            Reset to auto
          </button>
        )}
        <span style={{ fontSize: 12, color: effective ? '#4ade80' : '#f59e0b' }}>
          {effective ? `Projecting against ${effective}` : 'No stadium — field location unavailable'}
        </span>
      </div>
      {snapshot?.stadium_name && (
        <p className="muted" style={{ margin: '8px 0 0', fontSize: 11 }}>
          Tracker reported stadium: {snapshot.stadium_name}
          {override ? ' (overridden by your selection)' : ''}
        </p>
      )}
      {!detected && !override && (
        <p className="muted" style={{ margin: '8px 0 0', fontSize: 11 }}>
          The tracker only names a stadium when it prints an “A vs. B @ Stadium” line. Pick one
          here to check field placement without waiting for that.
        </p>
      )}
      {error && <p style={{ margin: '8px 0 0', fontSize: 11, color: '#f87171' }}>{error}</p>}
    </Card>
  )
}

function ProjectedLocation({ projection, contact }) {
  if (!projection) {
    return <p className="muted" style={{ margin: 0 }}>Waiting for a batted-ball measurement.</p>
  }
  const label = DISTANCE_SOURCE_LABELS[projection.distance_source] || projection.distance_source
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{
        padding: '9px 11px', borderRadius: 8, fontSize: 12,
        border: `1px solid ${projection.is_projected ? 'rgba(56, 189, 248, 0.5)' : 'rgba(74, 222, 128, 0.45)'}`,
        background: projection.is_projected ? 'rgba(56, 189, 248, 0.10)' : 'rgba(74, 222, 128, 0.08)',
        color: projection.is_projected ? '#7dd3fc' : '#86efac',
      }}>
        {label}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8 }}>
        <Measurement label="Plotted distance" value={formatMeasurement(projection.plotted_distance_ft, 'ft')} accent />
        <Measurement label="Spray angle" value={formatMeasurement(projection.spray_angle_deg, 'deg')} />
        <Measurement label="Plotted X" value={formatMeasurement(projection.plotted_x, '', 1)} />
        <Measurement label="Plotted Y" value={formatMeasurement(projection.plotted_y, '', 1)} />
      </div>
      <Rows object={{
        endpoint: contact?.endpoint,
        endpoint_status: contact?.endpointStatus,
        distance_source: projection.distance_source,
        plot_source: projection.plot_source,
        plot_angle_deg: projection.plot_angle_deg,
        launch_spray_angle_deg: projection.spray_angle_deg,
        stadium_key: projection.stadium_key,
        physics_distance_ft: projection.physics_distance_ft,
        physics_hang_time_sec: projection.physics_hang_time_sec,
        physics_x: projection.physics_x,
        physics_y: projection.physics_y,
        physics_minus_plotted_ft: projection.physics_vs_plotted_distance_ft,
      }} fields={[
        'endpoint', 'endpoint_status', 'distance_source', 'plot_source',
        'plot_angle_deg', 'launch_spray_angle_deg', 'stadium_key',
        'physics_distance_ft', 'physics_hang_time_sec', 'physics_x', 'physics_y',
        'physics_minus_plotted_ft',
      ]} />
      {projection.plot_source === 'launch_spray_angle' && (
        <p className="muted" style={{ margin: 0, fontSize: 11 }}>
          No tracked coordinates for this contact, so the marker is placed along the direction the
          ball left the bat. A curving ball does not hold that line, so treat the left/right
          placement as approximate.
        </p>
      )}
      {projection.plot_angle_deg != null && projection.spray_angle_deg != null
        && Math.abs(projection.plot_angle_deg - projection.spray_angle_deg) >= 3
        && projection.plot_source !== 'launch_spray_angle' && (
        <p className="muted" style={{ margin: 0, fontSize: 11 }}>
          The ball finished {Math.abs(projection.plot_angle_deg - projection.spray_angle_deg).toFixed(1)}°
          off the direction it left the bat — that curve is why the marker is placed from the
          tracked coordinates rather than the spray angle.
        </p>
      )}
      {projection.distance_source === 'tracked_endpoint' && projection.physics_vs_plotted_distance_ft != null && (
        <p className="muted" style={{ margin: 0, fontSize: 11 }}>
          On a ball with a real tracked landing, <code>physics_minus_plotted_ft</code> is how far
          off the real-world-gravity model would have been. That gap is the calibration signal for
          the model used when no landing is ever tracked.
        </p>
      )}
    </div>
  )
}

export default function TrackerAtBatPreview() {
  const [snapshot, setSnapshot] = useState(null)
  const [connectionError, setConnectionError] = useState(null)
  const [stadiumPending, setStadiumPending] = useState(false)
  const [stadiumError, setStadiumError] = useState(null)
  // null follows the live at-bat; a number pins the page to that PA so an
  // earlier at-bat can be inspected while the game keeps going.
  const [pinnedPaNumber, setPinnedPaNumber] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function refresh() {
      try {
        const url = pinnedPaNumber == null ? PREVIEW_URL : `${PREVIEW_URL}?at_bat=${pinnedPaNumber}`
        const response = await fetch(url, { cache: 'no-store' })
        if (!response.ok) throw new Error(`Preview service returned ${response.status}`)
        const next = await response.json()
        if (!cancelled) { setSnapshot(next); setConnectionError(null) }
      } catch (error) {
        if (!cancelled) setConnectionError(error.message)
      }
    }
    refresh()
    const timer = setInterval(refresh, 500)
    return () => { cancelled = true; clearInterval(timer) }
  }, [pinnedPaNumber])

  const atBats = useMemo(() => snapshot?.at_bats || [], [snapshot])

  // The preview drops its at-bats when the tracker stops, which would otherwise
  // leave the page pinned to a PA number that no longer exists.
  useEffect(() => {
    if (pinnedPaNumber == null) return
    if (!atBats.some((entry) => entry.pa_number === pinnedPaNumber)) setPinnedPaNumber(null)
  }, [atBats, pinnedPaNumber])

  const selectAtBat = useCallback((paNumber) => setPinnedPaNumber(paNumber), [])
  const followLive = useCallback(() => setPinnedPaNumber(null), [])

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const target = event.target
      if (target instanceof HTMLElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return
      const selected = snapshot?.selected_pa_number ?? null
      const index = atBats.findIndex((entry) => entry.pa_number === selected)
      const position = index >= 0 ? index : atBats.length - 1
      const nextPosition = position + (event.key === 'ArrowLeft' ? -1 : 1)
      if (nextPosition < 0 || nextPosition >= atBats.length) return
      event.preventDefault()
      setPinnedPaNumber(nextPosition === atBats.length - 1 ? null : atBats[nextPosition].pa_number)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [atBats, snapshot?.selected_pa_number])

  const selectStadium = async (stadiumKey) => {
    setStadiumPending(true)
    setStadiumError(null)
    try {
      // Carry the pinned at-bat through so the re-projected snapshot that comes
      // back is the at-bat being looked at, not whatever is live.
      const url = pinnedPaNumber == null ? STADIUM_URL : `${STADIUM_URL}?at_bat=${pinnedPaNumber}`
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stadium_key: stadiumKey }),
      })
      const next = await response.json()
      if (!response.ok) throw new Error(next?.error || `Preview service returned ${response.status}`)
      setSnapshot(next)
    } catch (error) {
      setStadiumError(error.message)
    } finally {
      setStadiumPending(false)
    }
  }

  const pa = snapshot?.display_at_bat || null
  const sessionDiagnostics = snapshot?.session_pitch_diagnostics || null
  const projection = pa?.preview_projection || null
  const landingSpot = useMemo(() => (
    pa?.hit_x != null && pa?.hit_y != null ? { x: pa.hit_x, y: pa.hit_y } : null
  ), [pa])
  const fieldedSpot = useMemo(() => (
    pa?.fielded_x != null && pa?.fielded_y != null ? { x: pa.fielded_x, y: pa.fielded_y } : null
  ), [pa])
  const contact = pa?.advanced_batted_ball_raw || null
  const fielded = pa?.advanced_fielding_raw || null

  // Every batted ball this session, for the spray chart. The at-bat index
  // already carries each one's world coordinates, so the whole session plots
  // without re-fetching anything. The selected at-bat is highlighted so it can
  // be picked out among the rest.
  const sessionHits = useMemo(() => atBats
    .filter((entry) => entry.hit_world_x != null && entry.hit_world_z != null)
    .map((entry) => ({
      ...entry,
      id: null,
      is_selected: entry.pa_number === snapshot?.selected_pa_number,
    })), [atBats, snapshot?.selected_pa_number])

  const resultFields = [
    'result', 'outs_on_play', 'rbi', 'run_scored', 'is_official_ab', 'is_earned_run',
    'trajectory', 'hit_notation', 'fielder_choice_out', 'is_error', 'error_position',
    'error_character', 'error_player', 'error_notation', 'is_nice_play',
  ]
  const battedFields = [
    'hit_stadium_key', 'hit_x', 'hit_y', 'fielded_x', 'fielded_y', 'hit_distance_ft',
    'hit_angle_deg', 'exit_velocity_mph', 'launch_angle_deg', 'hang_time_sec',
  ]
  const specialFields = [
    'star_hit_used', 'star_pitch_used', 'star_pitch_successful', 'is_buddy_jump',
    'buddy_jump_assist_position', 'buddy_jump_putout_position', 'is_robbed_hr', 'strikeout_type',
  ]
  const runnerFields = [
    'runner_on_first_before', 'runner_on_second_before', 'runner_on_third_before',
    'runners_before', 'runner_assignments',
  ]

  return (
    <div className="page" style={{ maxWidth: 1280, margin: '0 auto', display: 'grid', gap: 14 }}>
      <header style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px', alignItems: 'center' }}>
        {atBats.length > 0 && (
          <AtBatArrows
            atBats={atBats}
            selectedPaNumber={snapshot?.selected_pa_number ?? null}
            onSelect={selectAtBat}
            onFollowLive={followLive}
          />
        )}
        <div style={{ minWidth: 0 }}>
          <h1 style={{ marginBottom: 4 }}>Local Tracker At-Bat Preview</h1>
          <p className="muted" style={{ margin: 0 }}>
            Every at-bat this tracker session has produced · localhost only · nothing is saved to Supabase
          </p>
        </div>
      </header>

      <section className="panel" style={{ borderColor: snapshot?.writes_enabled === false ? '#22c55e' : '#ef4444' }}>
        <strong style={{ color: snapshot?.writes_enabled === false ? '#4ade80' : '#f87171' }}>
          {snapshot?.writes_enabled === false ? 'DATABASE WRITES DISABLED' : 'Waiting for local preview service'}
        </strong>
        <div style={{ marginTop: 5, fontSize: 12, color: '#cbd5e1' }}>
          {connectionError ? `Not connected: ${connectionError}` : `${snapshot?.tracker_status || 'Waiting'} · PID ${snapshot?.tracker_pid || '—'}`}
        </div>
      </section>

      <StadiumSelector
        snapshot={snapshot}
        onSelect={selectStadium}
        pending={stadiumPending}
        error={stadiumError}
      />

      {/* A preview service started before at-bat history existed answers /state
          without an at_bats list at all. Say so rather than quietly leaving the
          navigation off, which looks identical to the feature not working. */}
      {snapshot && !snapshot.at_bats && (
        <section className="panel" style={{ borderColor: '#f59e0b' }}>
          <strong style={{ color: '#f59e0b' }}>At-bat history unavailable — restart the preview service</strong>
          <p className="muted" style={{ margin: '5px 0 0', fontSize: 12 }}>
            The local preview service answering on port 4317 was started before at-bat history was
            added, so it only reports the at-bat happening now. Stop it and run{' '}
            <code>node scripts/tracker_at_bat_preview.mjs</code> again to page back through the session.
          </p>
        </section>
      )}

      {!pa ? (
        <section className="panel">
          <strong>Waiting for an at-bat…</strong>
          <p className="muted" style={{ marginBottom: 0 }}>Start the local preview command, leave Dolphin running, and begin a plate appearance.</p>
        </section>
      ) : (
        <>
          <section className="panel" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 20px', alignItems: 'center' }}>
            <strong>{pa.batter_name}</strong><span className="muted">vs.</span><strong>{pa.pitcher_name}</strong>
            <span>PA {pa.pa_number}</span>
            <span>{pa.half} {pa.inning}</span>
            <span style={{ color: 'var(--gold)', fontWeight: 800 }}>{pa.result ? formatPaResultLabel(pa) : 'In progress'}</span>
            <span>{pa.pitches?.length || 0} pitches</span>
          </section>

          <BattingStats pa={pa} contact={contact} />
          <PitchingStats pa={pa} />
          <FieldingStats pa={pa} fielded={fielded} contact={contact} />

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14 }}>
            <Card title="Landing / catch telemetry">
              <Rows object={{
                endpoint: contact?.endpoint,
                endpoint_status: contact?.endpointStatus,
                contact_sequence: contact?.contactSeq,
                endpoint_sequence: contact?.endpointSeq,
                game_x: contact?.x,
                game_y_height: contact?.y,
                game_z: contact?.z,
                flight_updates: contact?.flightUpdates,
                sampled_updates_seconds: contact?.sampledUpdatesSec,
              }} fields={[
                'endpoint', 'endpoint_status', 'contact_sequence', 'endpoint_sequence',
                'game_x', 'game_y_height', 'game_z', 'flight_updates', 'sampled_updates_seconds',
              ]} />
            </Card>
            <Card title="Fielding telemetry">
              <Rows object={{
                fielded_distance_ft: fielded?.distanceFeet,
                fielded_spray_angle_deg: fielded?.sprayAngleDeg,
                fielding_time_sec: fielded?.fieldingTimeSec,
                fielded_game_x: fielded?.x,
                fielded_game_y_height: fielded?.y,
                fielded_game_z: fielded?.z,
                fielded_sequence: fielded?.fieldedSeq,
                measurement_source: fielded?.source,
              }} fields={[
                'fielded_distance_ft', 'fielded_spray_angle_deg', 'fielding_time_sec',
                'fielded_game_x', 'fielded_game_y_height', 'fielded_game_z',
                'fielded_sequence', 'measurement_source',
              ]} />
            </Card>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 430px) minmax(0, 1fr)', gap: 14, alignItems: 'start' }}>
            <div style={{ display: 'grid', gap: 14 }}>
              <Card title="Field location">
                {pa.hit_stadium_key ? (
                  <FieldPlayBuilder
                    stadiumKey={pa.hit_stadium_key}
                    landingSpot={landingSpot}
                    secondarySpot={fieldedSpot}
                    primaryMarkerLabel={projection?.is_projected
                      ? 'Projected landing (no tracked landing)'
                      : 'First landing / catch'}
                    secondaryMarkerLabel="Fielded"
                    label=""
                    showFielderMarkers={false}
                    allowFielderSelection={false}
                  />
                ) : (
                  <p className="muted">
                    {snapshot?.stadium_key
                      ? 'Waiting for a batted-ball location.'
                      : 'Pick a stadium above to project the batted-ball location.'}
                  </p>
                )}
              </Card>

              {/* The measured-geometry chart, alongside the screenshot one
                  above so the two can be compared directly on the same hit.
                  This one draws the park from the fence measurements rather
                  than plotting onto artwork, so a marker sits exactly where
                  the ball's own coordinates say it did. */}
              <Card title="Spray chart (measured geometry)">
                {hasMeasuredGeometry(snapshot?.stadium_key) ? (
                  <>
                    <VectorSprayChart
                      plateAppearances={sessionHits}
                      initialStadiumKey={snapshot?.stadium_key}
                      height={430}
                    />
                    <p className="muted" style={{ margin: '8px 0 0', fontSize: 11 }}>
                      {sessionHits.length} tracked hit{sessionHits.length === 1 ? '' : 's'} this session ·
                      fence measured to 0.8 ft · {FEET_PER_UNIT.toFixed(3)} ft/unit
                    </p>
                  </>
                ) : (
                  <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                    {snapshot?.stadium_key
                      ? `${snapshot.stadium_key.replace(/_/g, ' ')} has not been measured yet — run
                         scripts/collect_fence_samples.py --mode press for this park.`
                      : 'Pick a stadium above.'}
                  </p>
                )}
              </Card>

              <Card title="Projected landing (X-Y)">
                <ProjectedLocation projection={projection} contact={contact} />
              </Card>

              <Card title={`Pitch sequence (${pa.pitches?.length || 0})`}>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 9, marginBottom: 8 }}>
                  <a
                    href={PITCH_DIAGNOSTICS_URL}
                    style={{
                      display: 'inline-block', padding: '7px 10px', borderRadius: 7,
                      border: '1px solid rgba(250, 204, 21, 0.55)',
                      background: 'rgba(250, 204, 21, 0.10)', color: '#fde047',
                      fontSize: 12, fontWeight: 800,
                    }}
                  >
                    Download session pitch diagnostics
                  </a>
                  <span className="muted" style={{ fontSize: 11 }}>
                    {sessionDiagnostics?.pitch_count || 0} pitches across {sessionDiagnostics?.at_bat_count || 0} at-bats retained until the tracker stops.
                  </span>
                </div>
                {pa.pitches?.length ? pa.pitches.map((pitch) => (
                  <div key={pitch.pitch_number_pa} style={{ padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.08)', fontSize: 12 }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 6 }}>
                      <strong style={{ color: 'var(--gold)' }}>#{pitch.pitch_number_pa} {formatPitchResultLabel(pitch.result)}</strong>
                      <strong>{formatMeasurement(pitch.pitch_speed_mph, 'mph')}</strong>
                    </div>
                    <div className="muted">Count {pitch.count_balls_before}-{pitch.count_strikes_before} → {pitch.count_balls_after}-{pitch.count_strikes_after} · type {pitch.pitch_type || 'unresolved'}{pitch.is_star_pitch ? ' · STAR' : ''}</div>
                    <PitchTelemetry pitch={pitch} />
                  </div>
                )) : <p className="muted">No pitches recorded yet.</p>}
              </Card>

              <Card title="Raw in-memory JSON">
                <pre style={{ margin: 0, maxHeight: 620, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 10, color: '#cbd5e1' }}>
                  {JSON.stringify(pa, null, 2)}
                </pre>
              </Card>
            </div>

            <div style={{ display: 'grid', gap: 14 }}>
              <Card title="Result and scoring"><Rows object={pa} fields={resultFields} /></Card>
              <Card title="Batted-ball data"><Rows object={pa} fields={battedFields} /></Card>
              <Card title="Special plays"><Rows object={pa} fields={specialFields} /></Card>
              <Card title="Runner data"><Rows object={pa} fields={runnerFields} /></Card>
              <Card title="Runs scored">
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 11 }}>{JSON.stringify(pa.runs_scored || [], null, 2)}</pre>
              </Card>
              <Card title="Fielding events">
                <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 11 }}>{JSON.stringify(pa.fielding_events || {}, null, 2)}</pre>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
