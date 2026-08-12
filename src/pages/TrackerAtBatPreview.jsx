import { useEffect, useMemo, useState } from 'react'
import FieldPlayBuilder from '../components/FieldPlayBuilder'
import { formatPaResultLabel, formatPitchResultLabel } from '../utils/notation'

const PREVIEW_URL = 'http://127.0.0.1:4317/state'

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

export default function TrackerAtBatPreview() {
  const [snapshot, setSnapshot] = useState(null)
  const [connectionError, setConnectionError] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function refresh() {
      try {
        const response = await fetch(PREVIEW_URL, { cache: 'no-store' })
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
  }, [])

  const pa = snapshot?.display_at_bat || null
  const landingSpot = useMemo(() => (
    pa?.hit_x != null && pa?.hit_y != null ? { x: pa.hit_x, y: pa.hit_y } : null
  ), [pa])
  const fieldedSpot = useMemo(() => (
    pa?.fielded_x != null && pa?.fielded_y != null ? { x: pa.fielded_x, y: pa.fielded_y } : null
  ), [pa])
  const contact = pa?.advanced_batted_ball_raw || null
  const fielded = pa?.advanced_fielding_raw || null

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
      <header>
        <h1 style={{ marginBottom: 4 }}>Local Tracker At-Bat Preview</h1>
        <p className="muted" style={{ margin: 0 }}>One at-bat at a time · localhost only · nothing is saved to Supabase</p>
      </header>

      <section className="panel" style={{ borderColor: snapshot?.writes_enabled === false ? '#22c55e' : '#ef4444' }}>
        <strong style={{ color: snapshot?.writes_enabled === false ? '#4ade80' : '#f87171' }}>
          {snapshot?.writes_enabled === false ? 'DATABASE WRITES DISABLED' : 'Waiting for local preview service'}
        </strong>
        <div style={{ marginTop: 5, fontSize: 12, color: '#cbd5e1' }}>
          {connectionError ? `Not connected: ${connectionError}` : `${snapshot?.tracker_status || 'Waiting'} · PID ${snapshot?.tracker_pid || '—'}`}
        </div>
      </section>

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

          <Card title="Tracked contact measurements">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', gap: 10 }}>
              <Measurement label="Exit velocity" value={formatMeasurement(pa.exit_velocity_mph, 'mph')} accent />
              <Measurement label="Launch angle" value={formatMeasurement(pa.launch_angle_deg, 'deg')} accent />
              <Measurement label="Hit distance (landing/catch)" value={formatMeasurement(pa.hit_distance_ft, 'ft')} accent />
              <Measurement label="Spray angle" value={formatMeasurement(pa.hit_angle_deg, 'deg')} />
              <Measurement label="Hang time" value={formatMeasurement(pa.hang_time_sec, 'sec', 2)} />
              <Measurement label="Trajectory" value={pa.trajectory || 'Waiting'} />
              <Measurement label="Endpoint" value={contact?.endpoint || 'Waiting'} />
              <Measurement label="Spray side" value={contact?.spraySide?.replaceAll('_', ' ') || 'Waiting'} />
            </div>
            {!contact && (
              <p className="muted" style={{ margin: '10px 0 0' }}>
                These values appear as soon as the tracker emits the fair landing or catch measurement.
              </p>
            )}
          </Card>

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
                    primaryMarkerLabel="First landing / catch"
                    secondaryMarkerLabel="Fielded"
                    label=""
                    showFielderMarkers={false}
                    allowFielderSelection={false}
                  />
                ) : <p className="muted">Waiting for a recognized stadium and batted-ball location.</p>}
              </Card>

              <Card title={`Pitch sequence (${pa.pitches?.length || 0})`}>
                {pa.pitches?.length ? pa.pitches.map((pitch) => (
                  <div key={pitch.pitch_number_pa} style={{ padding: '7px 0', borderBottom: '1px solid rgba(255,255,255,0.08)', fontSize: 12 }}>
                    <strong style={{ color: 'var(--gold)' }}>#{pitch.pitch_number_pa} {formatPitchResultLabel(pitch.result)}</strong>
                    <div className="muted">Count {pitch.count_balls_before}-{pitch.count_strikes_before} → {pitch.count_balls_after}-{pitch.count_strikes_after} · type {pitch.pitch_type || 'unresolved'}{pitch.is_star_pitch ? ' · STAR' : ''}</div>
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
