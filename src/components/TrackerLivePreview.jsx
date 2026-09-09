import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import FieldPlayBuilder from './FieldPlayBuilder'
import VectorSprayChart from './VectorSprayChart'
import TrackerPlayDiagram, { TrackerPlayBadge } from './TrackerPlayDiagram'
import TrackerAdvancedMetrics from './TrackerAdvancedMetrics'
import { FEET_PER_UNIT, hasMeasuredGeometry } from '../utils/parkGeometry'
import { formatPaResultLabel, formatPitchResultLabel, parseFielderChainFromNotation } from '../utils/notation'
import { isCreditedHit } from '../utils/creditedHit'
import { getCreditedRbiForPa, hasRispOpportunity, POSITION_LABELS } from '../utils/statsCalculator'
import {
  AT_BAT_FILTERS,
  annotateAtBats,
  buildGameHeader,
  buildPlayExplanation,
  countAtBatFilters,
  describeFeedStatus,
  feedRecovered,
  filterAtBats,
  findNextMatch,
  formatDuration,
  presentMeasurement,
  stepSelection,
  summarizeCaptureHealth,
} from '../utils/trackerConsoleView'
import '../styles/tracker-console.css'

// The live tracker validation console.
//
// This page has exactly one job: make it possible to decide, during a game and
// within a second or two of a play ending, whether the tracker understood it.
// Everything about the layout follows from that.
//
//   1. CAPTURE HEALTH FIRST, and pinned. Every number below it is worthless if
//      the capture is stalled, miscalibrated, or feeding a different game, and
//      those failures all look exactly like working correctly.
//
//   2. THE INTERPRETATION IS THE CENTREPIECE. A sentence can be judged at a
//      glance; a grid of two hundred stat tiles cannot. The four cards below it
//      are a status check, not the primary reading surface.
//
//   3. EVERY CLAUSE IS CLICKABLE, and opens the field it came from. A sentence
//      that cannot be traced back to a field is a claim, and this page does not
//      make claims.
//
//   4. EXHAUSTIVE DETAIL IS ONE CLICK AWAY AND NEVER ON SCREEN BY DEFAULT.
//      All of the previous version's telemetry is still here, inside
//      <details>. None of it competes with the sentence.
//
// Both tracker processes answer on this port and serve an identical API:
// scripts/tracker_at_bat_preview.mjs (read-only), scripts/live_tracker_bridge.mjs
// (writing to Supabase), and scripts/tracker_replay_preview.mjs (an archived
// session). The snapshot's own `mode` and `writes_enabled` say which -- this
// page deliberately does not need to be told.
export const DEFAULT_TRACKER_PREVIEW_BASE_URL = 'http://127.0.0.1:4317'

const DISTANCE_SOURCE_LABELS = {
  tracked_endpoint: 'Measured — real tracked landing/catch',
  tracked_collision: 'Measured — tracked wall/object contact',
  trajectory_projected_carry_from_collision: 'Projected carry — flight continued into a wall/object',
  tracker_last_frame_extrapolation: 'Projected — extrapolated from this shot’s last tracked frame',
  physics_from_exit_velocity: 'Projected — physics from exit velocity + launch angle',
  none: 'No distance available',
}

const ANNOTATION_CATEGORIES = [
  ['wrong_result', 'Wrong result'],
  ['wrong_player', 'Wrong player'],
  ['wrong_location', 'Wrong location'],
  ['wrong_trajectory', 'Wrong trajectory'],
  ['wrong_attempt', 'Wrong attempt'],
  ['wrong_contact', 'Wrong contact'],
  ['wrong_possession', 'Wrong possession'],
  ['wrong_ability', 'Wrong ability'],
  ['wrong_throw', 'Wrong throw'],
  ['wrong_runner', 'Wrong runner'],
  ['missing_event', 'Missing event'],
  ['wrong_measurement', 'Wrong measurement'],
  ['stadium_event', 'Stadium event'],
  ['other', 'Other'],
]

// A clause's status decides how confidently it may be rendered, so the styling
// is derived from it rather than chosen. `observed` is the only one that reads
// as plain fact.
const CLAUSE_STATUS_STYLES = {
  observed: { color: '#f8fafc', border: 'rgba(74, 222, 128, 0.55)', tag: 'observed', tagColor: '#4ade80' },
  derived: { color: '#e2e8f0', border: 'rgba(56, 189, 248, 0.5)', tag: 'derived', tagColor: '#38bdf8' },
  inferred: { color: '#e2e8f0', border: 'rgba(167, 139, 250, 0.5)', tag: 'inferred', tagColor: '#a78bfa' },
  unknown: { color: '#fcd34d', border: 'rgba(251, 191, 36, 0.6)', tag: 'unknown', tagColor: '#fbbf24' },
  pending: { color: '#94a3b8', border: 'rgba(148, 163, 184, 0.4)', tag: 'pending', tagColor: '#94a3b8' },
  not_applicable: { color: '#94a3b8', border: 'rgba(148, 163, 184, 0.3)', tag: 'context', tagColor: '#94a3b8' },
  mismatch: { color: '#fca5a5', border: 'rgba(248, 113, 113, 0.65)', tag: 'mismatch', tagColor: '#f87171' },
}

const CHECK_STYLES = {
  ok: { glyph: '✓', color: '#4ade80' },
  warn: { glyph: '!', color: '#fbbf24' },
  missing: { glyph: '×', color: '#f87171' },
  pending: { glyph: '·', color: '#64748b' },
  'n/a': { glyph: '–', color: '#475569' },
}

// --- primitives -------------------------------------------------------------

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

function Card({ title, children, tone = null, action = null, className = '' }) {
  return (
    <section className={`panel ${className}`.trim()} style={{ minWidth: 0, ...(tone ? { borderColor: tone } : {}) }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <h2 style={{ margin: 0, fontSize: 14 }}>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

// "Waiting" was said for every absent number, including on a finished replay
// where nothing is coming. The two states are different and the reader has to
// be able to tell them apart, so an absent value now says it is absent and a
// measured zero renders as a zero.
const MEASUREMENT_MISSING = 'Not measured'

function formatMeasurement(value, unit = '', digits = 1) {
  const number = Number(value)
  if (value === null || value === undefined || value === '' || !Number.isFinite(number)) {
    return MEASUREMENT_MISSING
  }
  return `${number.toFixed(digits)}${unit ? ` ${unit}` : ''}`
}

function Measurement({ label, value, accent = false }) {
  const missing = value === MEASUREMENT_MISSING
  return (
    <div
      title={missing ? 'Absent from the capture. Absent is not zero.' : undefined}
      style={{
        padding: '12px 14px',
        border: `1px solid ${accent && !missing ? 'rgba(250, 204, 21, 0.55)' : 'rgba(148, 163, 184, 0.22)'}`,
        borderRadius: 10,
        background: accent && !missing ? 'rgba(250, 204, 21, 0.08)' : 'rgba(15, 23, 42, 0.45)',
      }}
    >
      <div style={{ color: '#94a3b8', fontSize: 11, marginBottom: 4 }}>{label}</div>
      <strong style={{ color: missing ? '#94a3b8' : '#f8fafc', fontSize: missing ? 14 : 20 }}>{value}</strong>
    </div>
  )
}

// The stat sections are a completeness check on automatic tracking, so they
// render null as a loud "—" rather than hiding the row: a stat that never
// arrives is exactly what these sections exist to make visible.
function metric(value, unit = '', digits = 1) {
  const number = Number(value)
  if (value === null || value === undefined || value === '' || !Number.isFinite(number)) return null
  return `${number.toFixed(digits)}${unit ? ` ${unit}` : ''}`
}

function Stat({ label, value, accent = false, note = null, title = null }) {
  let text = value
  let color = '#f8fafc'
  let hint = title
  // An em dash on its own said "missing", "zero" and "false" in the same
  // three pixels. It still reads as a dash -- a grid of forty tiles cannot
  // spell out a sentence -- but it now carries the sentence in its tooltip and
  // in the screen-reader text, and a measured 0 is never rendered as one.
  if (value === null || value === undefined || value === '') {
    text = '—'
    color = '#94a3b8'
    hint = hint || 'Not measured. Absent is not zero.'
  } else if (value === true) { text = 'Yes'; color = '#4ade80' }
  else if (value === false) { text = 'No'; color = '#94a3b8' }
  const missing = text === '—'
  return (
    <div title={hint || undefined} style={{
      padding: '8px 10px',
      border: `1px solid ${accent ? 'rgba(250, 204, 21, 0.45)' : 'rgba(148, 163, 184, 0.22)'}`,
      borderRadius: 9,
      background: accent ? 'rgba(250, 204, 21, 0.07)' : 'rgba(15, 23, 42, 0.45)',
      minWidth: 0,
    }}>
      <div style={{ color: '#94a3b8', fontSize: 10, letterSpacing: 0.4, textTransform: 'uppercase', marginBottom: 3 }}>{label}</div>
      <strong style={{ color, fontSize: 15, overflowWrap: 'anywhere' }}>
        {text}
        {missing && <span className="tc-visually-hidden">not measured</span>}
      </strong>
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

// `onOpen` fires the first time a section is expanded. That is how the heavy
// 60 Hz evidence is fetched: on demand, but without making the operator press a
// second button once they have already said they want to see it.
function Drill({ label, children, open = false, onOpen = null }) {
  return (
    <details
      open={open}
      style={{ marginTop: 10 }}
      onToggle={(event) => { if (event.currentTarget.open && onOpen) onOpen() }}
    >
      <summary style={{ cursor: 'pointer', color: '#cbd5e1', fontSize: 11, fontWeight: 700, letterSpacing: 0.3 }}>
        {label}
      </summary>
      <div style={{ marginTop: 8 }}>{children}</div>
    </details>
  )
}

// --- 1. the game header and capture health ---------------------------------

// The header answers "what am I looking at" and the health panel answers "is it
// worth anything". Those were one undifferentiated grid of nineteen cells, in
// which a failed calibration and a frame rate of 59.1 were the same size and
// the same weight, and the operator had to already know which cells mattered.

function Chip({ tone = 'neutral', children, title = null }) {
  return (
    <span className={`tc-chip tc-chip--${tone}`} title={title || undefined}>{children}</span>
  )
}

function Fact({ label, value, missing = false, title = null, children = null }) {
  return (
    <div className="tc-fact" title={title || undefined}>
      <span className="tc-fact-label">{label}</span>
      {children || (
        <span className={`tc-fact-value${missing ? ' tc-fact-value--missing' : ''}`}>{value}</span>
      )}
    </div>
  )
}

// Balls, strikes and outs as pips as well as digits. A count read at a glance
// while a game is running is read as a shape long before it is read as text.
function CountPips({ balls, strikes, outs }) {
  const pip = (kind, filled, index) => (
    <span key={`${kind}-${index}`} className={`tc-pip${filled ? ` tc-pip--${kind}` : ''}`} />
  )
  return (
    <span className="tc-fact-value">
      <span className="tc-count" aria-hidden="true">
        {[0, 1, 2].map((index) => pip('ball', balls != null && index < balls, index))}
        <span style={{ width: 4 }} />
        {[0, 1].map((index) => pip('strike', strikes != null && index < strikes, index))}
        <span style={{ width: 4 }} />
        {[0, 1].map((index) => pip('out', outs != null && index < outs, index))}
      </span>
      <span className="tc-visually-hidden">
        {`${balls ?? 'unknown'} balls, ${strikes ?? 'unknown'} strikes, ${outs ?? 'unknown'} outs`}
      </span>
    </span>
  )
}

const MODE_TONES = { danger: 'bad', replay: 'info', safe: 'good', neutral: 'neutral' }

function GameHeader({
  snapshot, header, health, feed, gameMismatch, expectedGameId, baseUrl,
  onStop = null, stopPending = false, stopMessage = null,
  healthOpen, onToggleHealth, reviewing = null,
}) {
  const isLive = snapshot?.writes_enabled === true

  return (
    <section
      className={`tc-header tc-header--${health.level}${healthOpen ? ' tc-header--expanded' : ''}`}
      aria-label="Game and capture header"
    >
      <div className="tc-header-top">
        <Chip tone={MODE_TONES[header.modeTone] || 'neutral'} title={header.modeDetail || undefined}>
          {header.modeLabel}
        </Chip>
        <Chip tone={feed.tone} title={feed.detail}>{feed.label}</Chip>
        <Chip
          tone={health.level === 'blocked' ? 'bad' : health.level === 'degraded' ? 'warn' : health.level === 'healthy' ? 'good' : 'neutral'}
        >
          {health.headline}
        </Chip>
        {header.gameId != null && <Chip tone="neutral">game #{header.gameId}</Chip>}
        {/* The facts below are the LIVE situation. While the page is pinned to
            an earlier at-bat they describe a different moment from the one on
            screen, and without this the two read as a contradiction. */}
        {reviewing != null && (
          <Chip tone="info" title="The selected at-bat is pinned in the review workspace below">
            Live game now · PA {reviewing} selected below
          </Chip>
        )}

        <button
          type="button"
          className="tc-btn"
          aria-expanded={healthOpen}
          aria-controls="tc-health-detail"
          onClick={onToggleHealth}
          style={{ marginLeft: 'auto' }}
        >
          {healthOpen ? 'Hide capture health' : 'Capture health'}
          {health.blockers.length ? ` · ${health.blockers.length} blocker${health.blockers.length === 1 ? '' : 's'}` : ''}
        </button>
        {onStop && (
          <button type="button" className="tc-btn tc-btn--danger" onClick={onStop} disabled={stopPending}>
            {stopPending ? 'Saving capture…' : 'Save & end session'}
          </button>
        )}
      </div>

      {/* The matchup line, at the size a spectator reads rather than the size a
          diagnostic field is printed at. */}
      <div className="tc-header-facts">
        <Fact label="Batter" value={header.matchup.batter || 'Waiting'} missing={!header.matchup.batter} />
        <Fact label="Pitcher" value={header.matchup.pitcher || 'Waiting'} missing={!header.matchup.pitcher} />
        <Fact label="Park" value={header.park.label || 'Not resolved'} missing={!header.park.label}
          title={header.park.overridden ? 'Overridden by your selection' : header.park.reported || undefined} />
        <Fact label="Inning" value={header.inning.label || 'Waiting'} missing={!header.inning.label} />
        <Fact label={`Count ${header.count || '—'} · ${header.outs ?? '—'} out`}>
          <CountPips balls={header.balls} strikes={header.strikes} outs={header.outs} />
        </Fact>
        {/* NOT COMPUTED. No field in the preview snapshot carries a running
            score, and adding up the results this page can see would produce one
            that is quietly wrong whenever a runner scored on a play the index
            does not describe. */}
        <Fact
          label="Score"
          value={header.score.available ? `${header.score.away}–${header.score.home}` : 'Not reported'}
          missing={!header.score.available}
          title={header.score.available ? header.score.source : header.score.reason}
        />
        <Fact label="Tracker" value={header.trackerState || (header.connected ? 'connected' : 'waiting')}
          missing={!header.trackerState} />
      </div>

      {stopMessage && (
        <p style={{ margin: '8px 0 0', color: '#4ade80', fontSize: 11, fontWeight: 700 }}>{stopMessage}</p>
      )}

      {/* Blockers are always on screen, whatever the disclosure is doing. The
          whole point of a blocker is that it cannot be one click away. */}
      {health.blockers.length > 0 && (
        <div className="tc-findings" role="alert">
          {health.blockers.map((entry) => (
            <div key={entry.id} className="tc-finding tc-finding--blocker">
              <span aria-hidden="true">⛔</span>
              <span>
                <span className="tc-finding-label">{entry.label}</span>
                {entry.detail && <> — <span className="tc-finding-detail">{entry.detail}</span></>}
                {entry.field && <> <code className="tc-finding-field">{entry.field}</code></>}
              </span>
            </div>
          ))}
        </div>
      )}

      {gameMismatch && (
        <p style={{ margin: '8px 0 0', fontSize: 11, color: '#fecaca' }}>
          {baseUrl} is recording game #{snapshot?.game?.game_id}, but this scorebook is game
          {' '}#{expectedGameId}. Restart with <code>TRACKER_GAME_ID={expectedGameId}</code>.
        </p>
      )}

      {/* A stale feed is already stated as a blocker above; saying it twice in
          the same header is noise. A reconnection is not a blocker, so it is
          said here and only here. */}
      {feed.state === 'reconnecting' && (
        <p style={{ margin: '8px 0 0', fontSize: 11, color: '#fcd34d' }}>{feed.detail}</p>
      )}

      <div id="tc-health-detail" hidden={!healthOpen}>
        <CaptureHealthDetail health={health} isLive={isLive} />
      </div>
    </section>
  )
}

function FindingList({ title, findings, variant, glyph }) {
  if (!findings.length) return null
  return (
    <div style={{ marginTop: 10 }}>
      <h3 style={{ margin: '0 0 5px', fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase', color: '#cbd5e1' }}>
        {title} ({findings.length})
      </h3>
      <div className="tc-findings">
        {findings.map((entry) => (
          <div key={entry.id} className={`tc-finding tc-finding--${variant}`}>
            <span aria-hidden="true">{glyph}</span>
            <span>
              <span className="tc-finding-label">{entry.label}</span>
              {entry.detail && <> — <span className="tc-finding-detail">{entry.detail}</span></>}
              {entry.field && <> <code className="tc-finding-field">{entry.field}</code></>}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function CaptureHealthDetail({ health, isLive }) {
  return (
    <div style={{ marginTop: 10, borderTop: '1px solid rgba(148,163,184,0.2)', paddingTop: 10 }}>
      <div className="tc-metrics">
        {health.metrics.map((entry) => (
          <div key={entry.id} className="tc-metric" title={entry.field ? `${entry.field}` : undefined}>
            <span className="tc-fact-label">{entry.label}</span>
            <strong className={`tc-metric-value tc-metric-value--${entry.missing ? 'missing' : entry.tone}`}>
              {entry.missing ? 'Not reported' : entry.value}
            </strong>
            {entry.detail && <span className="tc-metric-detail">{entry.detail}</span>}
          </div>
        ))}
      </div>

      <FindingList title="Warnings" findings={health.warnings} variant="warning" glyph="⚠" />
      {/* The bucket that did not exist and caused the most confusion: a replay
          legitimately has no frame age and no lock margin, and rendering those
          in the same amber as a real problem trained the eye to ignore amber. */}
      <FindingList title="Not applicable to this session" findings={health.optional} variant="optional" glyph="·" />
      <FindingList title="Healthy" findings={health.healthy} variant="healthy" glyph="✓" />

      {isLive && (
        <p className="muted" style={{ margin: '10px 0 0', fontSize: 10 }}>
          This session is writing to Supabase. “Not saved” is a deliberate refusal, not a crash —
          the bridge never guesses a result it could not read.
        </p>
      )}
    </div>
  )
}

// --- 2. at-bat history ------------------------------------------------------

function ChecksGlyphs({ checks }) {
  if (!checks) return null
  const order = [['pitching', 'P'], ['batting', 'B'], ['fielding', 'F'], ['running', 'R']]
  return (
    <span style={{ display: 'inline-flex', gap: 5 }}>
      {order.map(([key, letter]) => {
        const style = CHECK_STYLES[checks[key]] || CHECK_STYLES.pending
        return (
          <span key={key} title={`${key}: ${checks[key]}`} style={{ color: style.color, fontSize: 11, fontWeight: 800 }}>
            {letter}{style.glyph}
          </span>
        )
      })}
    </span>
  )
}

const WRITE_STATUS_STYLES = {
  written: { color: '#4ade80', border: 'rgba(74, 222, 128, 0.5)', background: 'rgba(74, 222, 128, 0.10)', label: 'Saved' },
  skipped: { color: '#fbbf24', border: 'rgba(251, 191, 36, 0.55)', background: 'rgba(251, 191, 36, 0.10)', label: 'Not saved' },
  failed: { color: '#f87171', border: 'rgba(248, 113, 113, 0.55)', background: 'rgba(248, 113, 113, 0.12)', label: 'Write failed' },
  pending: { color: '#94a3b8', border: 'rgba(148, 163, 184, 0.35)', background: 'rgba(148, 163, 184, 0.08)', label: 'Not written yet' },
}

function WriteStatusBadge({ write, isCurrent = false }) {
  const status = write?.status || 'pending'
  const style = WRITE_STATUS_STYLES[status] || WRITE_STATUS_STYLES.pending
  const label = status === 'pending' && isCurrent ? 'In progress' : style.label
  return (
    <span style={{
      display: 'inline-block', padding: '3px 8px', borderRadius: 999,
      border: `1px solid ${style.border}`, background: style.background,
      color: style.color, fontSize: 10, fontWeight: 800, letterSpacing: 0.4,
      textTransform: 'uppercase', whiteSpace: 'nowrap',
    }}>{label}</span>
  )
}

function writeTally(atBats, isLive) {
  if (!isLive) return null
  const tally = { written: 0, skipped: 0, failed: 0, pending: 0 }
  atBats.forEach((entry) => {
    const status = entry.supabase_write?.status || 'pending'
    if (status === 'pending' && entry.is_current) return
    tally[status] = (tally[status] || 0) + 1
  })
  return tally
}

// The whole session, navigable. A completed at-bat stays selected until the
// operator moves -- following live is opt-in, because an at-bat that vanishes
// the moment the next batter steps in cannot be reviewed.
//
// The strip used to be the only way through the session: ninety-eight buttons
// in one horizontal scroller, with the fourteen at-bats that actually needed
// looking at distributed somewhere inside it. The filters and the two jump
// buttons exist so that "show me every warning" is one click rather than a
// scroll and a colour hunt.
function AtBatHistory({
  atBats, allAtBats, selectedPaNumber, following, onSelect, onFollowLive, isLive,
  filter, onFilter, counts,
}) {
  const stripRef = useRef(null)
  const index = atBats.findIndex((entry) => entry.pa_number === selectedPaNumber)
  const position = index >= 0 ? index : atBats.length - 1

  useEffect(() => {
    const node = stripRef.current?.querySelector('[aria-current="true"]')
    if (node) node.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [selectedPaNumber, filter])

  const step = (delta) => {
    const next = stepSelection(atBats, selectedPaNumber, delta)
    if (next != null) onSelect(next)
  }
  const jump = (predicate, direction) => {
    // Jumps search the WHOLE session, not the current filter: an operator who
    // has filtered to balls in play still wants the next warning.
    const next = findNextMatch(allAtBats, selectedPaNumber, predicate, direction)
    if (next != null) onSelect(next)
  }
  const warningsExist = counts.warnings > 0

  return (
    <aside className="panel tc-history" aria-label="Plate appearance navigation">
      <div className="tc-history-heading">
        <div>
          <h2>At-bats</h2>
          <span className="muted">
            {atBats.length === counts.all
              ? `${counts.all} this session`
              : `${atBats.length} of ${counts.all}`}
          </span>
        </div>
        <button
          type="button"
          className="tc-btn tc-btn--primary"
          aria-pressed={following}
          onClick={onFollowLive}
          title="Jump to the newest at-bat and keep following it"
        >
          {following ? '● Live' : 'Return to live'}
        </button>
      </div>

      <div className="tc-nav tc-history-stepper">
        <button type="button" className="tc-btn" onClick={() => step(-1)}
          disabled={position <= 0} title="Previous at-bat (Left arrow)">
          ← Previous
        </button>
        <button type="button" className="tc-btn" onClick={() => step(1)}
          disabled={position >= atBats.length - 1} title="Next at-bat (Right arrow)">
          Next →
        </button>
        <button type="button" className="tc-btn" disabled={!warningsExist}
          onClick={() => jump((entry) => entry.has_warnings, -1)}
          title="Previous at-bat with a warning (Shift + Left arrow)">
          ⚠ ←<span className="tc-visually-hidden"> previous warning</span>
        </button>
        <button type="button" className="tc-btn" disabled={!warningsExist}
          onClick={() => jump((entry) => entry.has_warnings, 1)}
          title="Next at-bat with a warning (Shift + Right arrow)">
          ⚠ →<span className="tc-visually-hidden"> next warning</span>
        </button>
      </div>

      <label className="tc-history-filter">
        <span>Show</span>
        <select value={filter} onChange={(event) => onFilter(event.target.value)}>
          {AT_BAT_FILTERS.map((entry) => (
            <option key={entry.id} value={entry.id} disabled={entry.id !== 'all' && !counts[entry.id]}>
              {entry.label} ({counts[entry.id] ?? 0})
            </option>
          ))}
        </select>
      </label>

      {!atBats.length && (
        <p className="muted" style={{ margin: '10px 0 0', fontSize: 12 }}>
          No at-bat matches this filter. The session has {counts.all}.
        </p>
      )}

      <div ref={stripRef} className="tc-strip" role="listbox" aria-label="Plate appearances" tabIndex={-1}>
        {atBats.map((entry) => {
          const selected = entry.pa_number === selectedPaNumber
          const className = `tc-strip-item${entry.has_errors ? ' tc-strip-item--warning'
            : entry.uncertain ? ' tc-strip-item--uncertain' : ''}`
          return (
            <button
              key={entry.pa_number}
              type="button"
              role="option"
              aria-selected={selected}
              aria-current={selected}
              // A stable handle for the browser harness. The visible text runs
              // "PA 68" and "T8" together in textContent, so a text matcher
              // cannot address one at-bat reliably.
              data-pa-number={entry.pa_number}
              className={className}
              onClick={() => onSelect(entry.pa_number)}
              title={entry.narrative_summary || undefined}
            >
              <span style={{ display: 'flex', gap: 7, alignItems: 'baseline', fontSize: 11 }}>
                <strong style={{ color: selected ? '#fde047' : '#cbd5e1' }}>PA {entry.pa_number}</strong>
                <span style={{ color: '#64748b' }}>
                  {entry.half === 'top' ? 'T' : 'B'}{entry.inning}
                </span>
                <span style={{ color: '#94a3b8', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {entry.batter_name} vs {entry.pitcher_name}
                </span>
              </span>
              <span style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 3, flexWrap: 'wrap' }}>
                <strong style={{ color: 'var(--gold)', fontSize: 12 }}>
                  {entry.result || 'no result'}
                </strong>
                <ChecksGlyphs checks={entry.checks} />
                {entry.has_warnings && (
                  <span style={{ color: '#f87171', fontSize: 10, fontWeight: 800 }}>
                    ⚠ {entry.error_count || entry.warning_count}
                  </span>
                )}
                {isLive && entry.supabase_write?.status && entry.supabase_write.status !== 'written' && (
                  <span style={{ color: '#fbbf24', fontSize: 10, fontWeight: 800 }}>
                    {entry.supabase_write.status}
                  </span>
                )}
              </span>
            </button>
          )
        })}
      </div>
      <p className="tc-history-shortcuts muted">←/→ move · Shift + ←/→ finds warnings</p>
    </aside>
  )
}

// --- 3. the interpretation --------------------------------------------------

// One paragraph for a reader who did not watch the capture.
//
// The clause list below it is the authority and stays exactly as it was; this
// is a way in, not a replacement. It is built from the same clauses, so it
// cannot name a fielder, an ability or a distance the sentences refused to --
// and the last third of it is the part that is usually dropped in a summary
// and must not be here: WHAT IS STILL UNKNOWN.
function PlayExplanation({ explanation, play }) {
  if (!explanation) return null
  const tone = {
    complete: 'good', partial: 'warn', pending: 'neutral', unavailable: 'bad',
  }[explanation.status] || 'neutral'

  return (
    <section className="panel" style={{ borderColor: 'rgba(56, 189, 248, 0.4)' }} aria-label="Play summary">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 12px', alignItems: 'center' }}>
        <h2 style={{ margin: 0, fontSize: 17, color: '#f8fafc', fontWeight: 700 }}>
          {explanation.headline}
        </h2>
        <Chip tone={tone}>{explanation.status}</Chip>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 22px', marginTop: 9 }}>
        <Fact label="Batter" value={explanation.batter || 'Unknown'} missing={!explanation.batter} />
        <Fact label="Result" value={explanation.resultLabel || 'Not scored yet'} missing={!explanation.result} />
        <Fact
          label="Primary fielder"
          value={explanation.primary?.position
            ? `${explanation.primary.character ? `${explanation.primary.character} ` : ''}${explanation.primary.position}`
            : 'None charged'}
          missing={!explanation.primary?.position}
          title={explanation.primary?.reason ? `because: ${explanation.primary.reason}` : undefined}
        />
        {explanation.primary?.reason && (
          <Fact label="Why" value={String(explanation.primary.reason).replace(/_/g, ' ')} />
        )}
      </div>

      {explanation.evidence.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <h3 style={{ margin: '0 0 5px', fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase', color: '#cbd5e1' }}>
            Evidence
          </h3>
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexWrap: 'wrap', gap: '5px 8px' }}>
            {explanation.evidence.map((item) => (
              <li key={item.label}>
                <span className="tc-chip tc-chip--neutral" title={item.source}>
                  {item.label}: <strong style={{ color: '#f8fafc' }}>{item.value}</strong>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {explanation.uncertainty.length > 0 ? (
        <div style={{ marginTop: 10 }}>
          <h3 style={{ margin: '0 0 5px', fontSize: 11, letterSpacing: 0.5, textTransform: 'uppercase', color: '#fbbf24' }}>
            Not established ({explanation.uncertainty.length})
          </h3>
          <div className="tc-findings">
            {explanation.uncertainty.map((item, index) => (
              <div key={`${item.label}-${index}`} className="tc-finding tc-finding--warning">
                <span aria-hidden="true">?</span>
                <span>
                  <span className="tc-finding-label">{item.label}</span>
                  {item.detail && <> — <span className="tc-finding-detail">{item.detail}</span></>}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="muted" style={{ margin: '10px 0 0', fontSize: 11 }}>
          Every clause in this interpretation is observed, derived or inferred — none is unknown or
          contradicted. That is not the same as correct.
        </p>
      )}

      {play?.badges?.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 10 }}>
          {play.badges.map((badge) => <TrackerPlayBadge key={badge} label={badge} />)}
        </div>
      )}
    </section>
  )
}

function SelectedPlayHeader({ pa, checks, currentPaNumber, pinned, onFlag, isLive, write }) {
  const historical = pinned && currentPaNumber != null && pa.pa_number !== currentPaNumber
  return (
    <section id="tc-main" className="panel tc-selected-play" aria-label={`Selected plate appearance ${pa.pa_number}`}>
      <div className="tc-selected-kicker">
        <span>{historical ? 'Reviewing earlier at-bat' : pinned ? 'Selected at-bat' : 'Following live'}</span>
        <strong>PA {pa.pa_number} · {pa.half === 'top' ? 'Top' : 'Bottom'} {pa.inning}</strong>
      </div>
      <div className="tc-selected-matchup">
        <strong title={pa.batter_name}>{pa.batter_name}</strong>
        <span>vs</span>
        <strong title={pa.pitcher_name}>{pa.pitcher_name}</strong>
      </div>
      <div className="tc-selected-result">
        <strong>{pa.result ? formatPaResultLabel(pa) : 'Outcome pending'}</strong>
        <span>{pa.outs_before_pa ?? '—'} out{pa.outs_before_pa === 1 ? '' : 's'} before · {pa.pitches?.length || 0} pitches</span>
      </div>
      <ChecksGlyphs checks={checks} />
      {isLive && <WriteStatusBadge write={write} isCurrent={pa.pa_number === currentPaNumber} />}
      <div className="tc-selected-actions">
        <button type="button" className="tc-btn tc-btn--danger" onClick={onFlag}>Flag play</button>
      </div>
    </section>
  )
}

function CompactMetric({ label, value, note = null, tone = 'neutral' }) {
  return (
    <div className={`tc-key-metric tc-key-metric--${tone}`} title={note || undefined}>
      <span>{label}</span>
      <strong>{value}</strong>
      {note && <small>{note}</small>}
    </div>
  )
}

function PlayReviewSummary({ pa, play, explanation, warnings, advancedMetrics, projection }) {
  const assignments = Array.isArray(pa.runner_assignments) ? pa.runner_assignments : []
  const runs = Array.isArray(pa.runs_scored) ? pa.runs_scored.length : 0
  const advancedRows = advancedMetrics?.rows || []
  const missingRows = advancedRows.filter((row) => row.value == null || row.status === 'missing')
  const selectedMetrics = []
  const addMetric = (label, value, note = null, tone = 'neutral') => {
    if (value == null || value === '') return
    selectedMetrics.push({ label, value, note, tone })
  }

  addMetric('Exit velocity', pa.exit_velocity_mph == null ? null : `${Number(pa.exit_velocity_mph).toFixed(1)} mph`)
  addMetric('Launch angle', pa.launch_angle_deg == null ? null : `${Number(pa.launch_angle_deg).toFixed(1)}°`)
  addMetric(
    projection?.is_projected ? 'Projected distance' : 'Measured distance',
    pa.hit_distance_ft == null ? null : `${Number(pa.hit_distance_ft).toFixed(1)} ft`,
    projection ? DISTANCE_SOURCE_LABELS[projection.distance_source] || projection.distance_source : null,
    projection?.is_projected ? 'info' : 'neutral',
  )
  addMetric('Hang time', play?.hang_time_s == null ? null : `${Number(play.hang_time_s).toFixed(2)} s`)

  const priority = [
    ['Reaction time', 'Fielding'],
    ['Route efficiency', 'Fielding'],
    ['Peak throw speed', 'Throws'],
    ['Sprint speed', 'Running'],
    ['Home to first', 'Running'],
  ]
  for (const [label, group] of priority) {
    const matches = advancedRows.filter((row) => row.label === label && row.group === group && row.value != null)
    for (const row of matches) {
      const value = presentMeasurement(row.value, { unit: row.unit || '', digits: 2, status: row.status, note: row.note })
      addMetric(label, value.text, `${row.actor}${row.note ? ` · ${row.note}` : ''}`, value.tone === 'projected' ? 'info' : row.status === 'excluded' ? 'warn' : 'neutral')
    }
  }

  const warningDetails = new Set((warnings || []).map((warning) => warning.detail))
  const uncertainty = (explanation?.uncertainty || []).filter((item) => !warningDetails.has(item.detail))
  const joinStatus = play?.join_status || (play ? 'pending' : 'not joined')
  const joinProblem = joinStatus !== 'joined'
  const noProblems = !(warnings?.length || uncertainty.length || joinProblem || !pa.result)
  const primaryActor = advancedRows.find((row) => (
    row.group === 'Fielding' && row.actor?.includes(`(${play?.primary_fielder})`)
  ))?.actor

  return (
    <section className="panel tc-review-summary" aria-label="Selected play review checklist">
      <div className="tc-review-summary-heading">
        <div>
          <span className="tc-section-label">At-bat check</span>
          <h2>{explanation?.headline || (pa.result ? formatPaResultLabel(pa) : 'Play in progress')}</h2>
        </div>
        <Chip tone={joinProblem ? 'bad' : 'good'}>{joinProblem ? `Tracking ${joinStatus}` : 'Tracking joined'}</Chip>
      </div>

      <div className="tc-outcome-grid">
        <Fact label="Recorded outcome" value={pa.result ? formatPaResultLabel(pa) : 'Missing'} missing={!pa.result} />
        <Fact label="Outs on play" value={pa.outs_on_play ?? 'Not reported'} missing={pa.outs_on_play == null} />
        <Fact label="Runs on play" value={runs} />
        <Fact label="RBI" value={pa.rbi ?? 'Not reported'} missing={pa.rbi == null} />
      </div>

      {(warnings?.length > 0 || uncertainty.length > 0 || joinProblem || !pa.result) && (
        <div className="tc-review-block tc-review-problems" role="alert">
          <h3>Needs attention</h3>
          {joinProblem && <p><strong>Tracking did not join cleanly.</strong> {play?.join_reason || 'No 60 Hz play is attached to this at-bat.'}</p>}
          {!pa.result && <p><strong>Recorded outcome is missing.</strong> The play remains unscored.</p>}
          {(warnings || []).map((warning) => (
            <p key={warning.id} className={warning.severity === 'error' ? 'tc-problem-error' : ''}>
              <strong>{warning.title}</strong> — {warning.detail}
            </p>
          ))}
          {uncertainty.map((item, index) => (
            <p key={`${item.label}-${index}`}><strong>{item.label}</strong>{item.detail ? ` — ${item.detail}` : ''}</p>
          ))}
        </div>
      )}

      <div className="tc-review-foot">
        {noProblems ? <span className="tc-all-clear">✓ No contradictions detected</span> : <span>Review the highlighted items before continuing.</span>}
        {advancedMetrics?.status === 'ready' && (
          <span className={missingRows.length ? 'tc-measurement-gap' : ''}>
            {advancedRows.length - missingRows.length}/{advancedRows.length} measurements available
            {missingRows.length ? ` · missing: ${missingRows.map((row) => row.label).join(', ')}` : ''}
          </span>
        )}
      </div>

      <div className="tc-review-block">
        <h3>Runner advances</h3>
        {assignments.length ? (
          <ul className="tc-runner-list">
            {assignments.map((assignment) => (
              <li key={assignment.id || `${assignment.origin}-${assignment.destination}`}>
                <strong>{assignment.runner?.characterName || 'Unknown runner'}</strong>
                <span>{assignment.isBatter ? 'plate' : assignment.origin || 'unknown'} → {assignment.destination || 'unresolved'}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="tc-inline-warning">Runner advances unresolved</p>
        )}
      </div>

      <div className="tc-review-block">
        <h3>Measured on this play</h3>
        <div className="tc-key-metrics">
          <CompactMetric
            label="Primary fielding"
            value={play?.primary_fielder
              ? primaryActor || play.primary_fielder
              : 'Not established'}
            note={play?.primary_fielder_reason ? String(play.primary_fielder_reason).replace(/_/g, ' ') : null}
            tone={play?.primary_fielder ? 'neutral' : 'warn'}
          />
          <CompactMetric
            label="First touch"
            value={play ? `${play.first_touch_character || 'Unknown'} · ${play.first_touch_by || 'position unknown'}` : 'Not measured'}
            tone={play ? 'neutral' : 'warn'}
          />
          <CompactMetric label="Fielding / throws" value={play ? `${play.confirmed_contacts ?? 0} contacts · ${play.throw_count ?? 0} throws` : 'Not measured'} tone={play ? 'neutral' : 'warn'} />
          {selectedMetrics.slice(0, 6).map((entry, index) => (
            <CompactMetric key={`${entry.label}-${index}`} {...entry} />
          ))}
        </div>
      </div>

      {play?.badges?.length > 0 && (
        <div className="tc-play-badges">
          {play.badges.map((badge) => <TrackerPlayBadge key={badge} label={badge} />)}
        </div>
      )}

    </section>
  )
}

function ClauseDetail({ clause, onFlag }) {
  const style = CLAUSE_STATUS_STYLES[clause.status] || CLAUSE_STATUS_STYLES.pending
  return (
    <div style={{
      marginTop: 8, padding: '10px 12px', borderRadius: 9,
      border: `1px solid ${style.border}`, background: 'rgba(15, 23, 42, 0.7)',
    }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 12px', alignItems: 'center', marginBottom: 7 }}>
        <span style={{ color: style.tagColor, fontSize: 10, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase' }}>
          {clause.status}
        </span>
        <span style={{ color: '#94a3b8', fontSize: 10, letterSpacing: 0.5, textTransform: 'uppercase' }}>
          {clause.category}
        </span>
        <code style={{ color: '#64748b', fontSize: 10 }}>{clause.id}</code>
        <button
          type="button"
          onClick={() => onFlag(clause)}
          style={{
            marginLeft: 'auto', padding: '3px 9px', borderRadius: 6, fontSize: 10, fontWeight: 800,
            cursor: 'pointer', border: '1px solid rgba(248,113,113,0.5)',
            background: 'rgba(248,113,113,0.10)', color: '#fca5a5',
          }}
        >Flag this clause</button>
      </div>
      <div style={{ fontSize: 11, color: '#cbd5e1', marginBottom: 6 }}>
        <strong style={{ color: '#94a3b8' }}>Source:</strong> <code style={{ fontSize: 10 }}>{clause.source}</code>
      </div>
      <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>Supporting fields</div>
      <pre style={{
        margin: 0, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere', fontSize: 10, color: '#cbd5e1',
      }}>{JSON.stringify(clause.evidence, null, 2)}</pre>
    </div>
  )
}

function InterpretationPanel({ interpretation, atBat, onFlag }) {
  const [openClauseId, setOpenClauseId] = useState(null)
  useEffect(() => { setOpenClauseId(null) }, [atBat?.pa_number])

  if (!interpretation) {
    return (
      <section className="panel">
        <div style={{ color: '#94a3b8', fontSize: 12 }}>Tracker interpreted this play as:</div>
        <p style={{ margin: '6px 0 0', fontSize: 18, color: '#f59e0b' }}>Waiting for an at-bat.</p>
      </section>
    )
  }

  const statusTone = {
    complete: { color: '#4ade80', label: 'complete — at-bat and 60 Hz play both present' },
    partial: { color: '#fbbf24', label: 'partial — no 60 Hz play joined, so fielding detail is missing' },
    pending: { color: '#94a3b8', label: 'in progress' },
    unavailable: { color: '#f87171', label: 'unavailable' },
  }[interpretation.status] || { color: '#94a3b8', label: interpretation.status }

  return (
    <section className="panel tc-interpretation-panel">
      <details className="tc-interpretation-details">
        <summary>
          <span>Interpretation & source fields</span>
          <span style={{ color: statusTone.color }}>{statusTone.label}</span>
        </summary>

      <div className="tc-clause-list">
        {interpretation.clauses.map((clause) => {
          const style = CLAUSE_STATUS_STYLES[clause.status] || CLAUSE_STATUS_STYLES.pending
          const open = openClauseId === clause.id
          return (
            <div key={clause.id}>
              <button
                type="button"
                aria-expanded={open}
                aria-controls={`tc-clause-${clause.id}`}
                onClick={() => setOpenClauseId(open ? null : clause.id)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                  padding: '7px 11px', borderRadius: 8,
                  // Longhand on all four sides. React warns when a shorthand
                  // and a longhand for the same property are both set during a
                  // rerender, because which one wins depends on update order.
                  borderTop: `1px solid ${open ? style.border : 'transparent'}`,
                  borderRight: `1px solid ${open ? style.border : 'transparent'}`,
                  borderBottom: `1px solid ${open ? style.border : 'transparent'}`,
                  borderLeft: `3px solid ${style.border}`,
                  background: open ? 'rgba(30, 41, 59, 0.75)' : 'rgba(15, 23, 42, 0.35)',
                  color: style.color,
                  fontSize: 19, lineHeight: 1.45, fontWeight: 500,
                }}
              >
                {clause.text}
                <span style={{
                  marginLeft: 9, color: style.tagColor, fontSize: 10, fontWeight: 800,
                  letterSpacing: 0.5, textTransform: 'uppercase', verticalAlign: 'middle',
                }}>{style.tag}</span>
              </button>
              <div id={`tc-clause-${clause.id}`} hidden={!open}>
                {open && <ClauseDetail clause={clause} onFlag={onFlag} />}
              </div>
            </div>
          )
        })}
      </div>

      <p className="muted" style={{ margin: '10px 0 0', fontSize: 10 }}>
        Every sentence is generated by a rule from a named field — no language model is involved.
        Click any sentence for the exact fields behind it. Colour is the sentence&apos;s status:
        green observed, blue derived, amber unknown, red contradicted.
      </p>
      </details>
    </section>
  )
}

// --- 4. warnings ------------------------------------------------------------

function WarningsPanel({ warnings, onFlag, onJumpWarning = null, warningAtBats = 0 }) {
  if (!warnings?.length) {
    return (
      <section className="panel" style={{ borderColor: 'rgba(74, 222, 128, 0.35)', padding: '9px 13px' }}
        aria-label="Automatic validation">
        <strong style={{ color: '#4ade80', fontSize: 12 }}>No contradictions detected in this at-bat</strong>
        <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>
          Consistency checks found no two facts that disagree. That is not the same as correct.
        </span>
        {/* The session-level count belongs here even when THIS at-bat is
            clean: an operator reading a quiet play still needs to know that
            fourteen other at-bats are not. */}
        {warningAtBats > 0 && onJumpWarning && (
          <button type="button" className="tc-btn" style={{ marginLeft: 10 }}
            onClick={() => onJumpWarning(1)}>
            {warningAtBats} other at-bat{warningAtBats === 1 ? '' : 's'} in this session have warnings — go to the next
          </button>
        )}
      </section>
    )
  }
  const tone = { error: '#f87171', warning: '#fbbf24', info: '#94a3b8' }
  const errors = warnings.filter((warning) => warning.severity === 'error').length
  return (
    <section
      className="panel"
      style={{ borderColor: errors ? '#ef4444' : '#f59e0b' }}
      aria-label="Automatic validation warnings"
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
        <strong style={{ color: '#fbbf24', fontSize: 13 }}>
          {warnings.length} automatic warning{warnings.length === 1 ? '' : 's'}
          {errors ? ` · ${errors} error${errors === 1 ? '' : 's'}` : ''}
        </strong>
        <span className="muted" style={{ fontSize: 11 }}>
          A warning is a reason to look, never a reason to change data.
        </span>
        {onJumpWarning && warningAtBats > 1 && (
          <span className="tc-nav">
            <button type="button" className="tc-btn" onClick={() => onJumpWarning(-1)}>⚠ Previous</button>
            <button type="button" className="tc-btn" onClick={() => onJumpWarning(1)}>⚠ Next</button>
          </span>
        )}
        <button type="button" className="tc-btn tc-btn--danger" style={{ marginLeft: 'auto' }}
          onClick={() => onFlag(null)}>Something is wrong</button>
      </div>
      <ul style={{ display: 'grid', gap: 6, marginTop: 9, padding: 0, listStyle: 'none' }}>
        {warnings.map((warning) => (
          <li key={warning.id} style={{
            padding: '7px 10px', borderRadius: 7,
            border: `1px solid ${tone[warning.severity]}55`, background: `${tone[warning.severity]}12`,
          }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <span style={{ color: tone[warning.severity], fontSize: 9, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase' }}>
                {warning.severity}
              </span>
              <strong style={{ color: '#f8fafc', fontSize: 12 }}>{warning.title}</strong>
              <code style={{ color: '#64748b', fontSize: 10 }}>{warning.id}</code>
            </div>
            <div style={{ fontSize: 11, color: '#cbd5e1', marginTop: 3 }}>{warning.detail}</div>
            <Drill label="The two fields that disagree">
              <pre style={{ margin: 0, fontSize: 10, color: '#94a3b8', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {JSON.stringify(warning.fields, null, 2)}
              </pre>
            </Drill>
          </li>
        ))}
      </ul>
    </section>
  )
}

// --- 5. the four validation cards -------------------------------------------

const TOTAL_BASES_BY_RESULT = { '1B': 1, '2B': 2, '3B': 3, HR: 4, IPHR: 4 }
const TRAJECTORY_LABELS = { G: 'Ground ball (G)', L: 'Line drive (L)', F: 'Fly ball (F)', B: 'Bunt (B)' }
const STRIKEOUT_TYPE_LABELS = { KS: 'Swinging (KS)', KL: 'Looking (KL)' }
const SPRAY_SIDE_LABELS = { third_base: 'Left (3B side)', center: 'Center', first_base: 'Right (1B side)' }
const BATTER_OUT_RESULTS = new Set(['K', 'GO', 'FO', 'LO', 'DP', 'TP', 'SF', 'SH'])
const BALL_PITCH_RESULTS = new Set(['ball', 'hbp'])

// The ability the narrative CONFIRMED, if any. Read off the clauses rather
// than looked up again: a card that consulted the character mapping directly
// would print a name the sentence above it deliberately refused to.
function confirmedAbility(interpretation, kind) {
  const clause = (interpretation?.clauses || []).find((entry) => (
    entry.category === 'ability'
    && entry.evidence?.status === 'confirmed'
    && (kind === 'pitch'
      ? String(entry.evidence.evidence || '').includes('star_pitch')
      : String(entry.evidence.evidence || '').includes('star_swing'))
  ))
  return clause?.evidence?.abilityName ?? null
}

// The zone the narrative named, for the batting card. Same rule: one source.
function narrativeZone(interpretation) {
  const clause = (interpretation?.clauses || []).find((entry) => entry.category === 'contact')
  return clause?.evidence?.zone ?? null
}

function positionLabel(position) {
  if (position == null) return null
  return `${position}${POSITION_LABELS[position] ? ` (${POSITION_LABELS[position]})` : ''}`
}

function nameList(names) {
  const clean = (names || []).filter(Boolean)
  return clean.length ? clean.join(', ') : null
}

function CheckHeader({ label, status }) {
  const style = CHECK_STYLES[status] || CHECK_STYLES.pending
  return (
    <span style={{ display: 'inline-flex', gap: 7, alignItems: 'baseline' }}>
      <span>{label}</span>
      <span style={{ color: style.color, fontSize: 13, fontWeight: 900 }}>{style.glyph}</span>
      <span style={{ color: style.color, fontSize: 10, fontWeight: 700, letterSpacing: 0.5 }}>{status}</span>
    </span>
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
        <Measurement label="XYZ samples" value={telemetry.sampleCount ?? MEASUREMENT_MISSING} />
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
        horizontal_chord_deviation_max_units: telemetry.horizontalChordDeviationMaxUnits,
        horizontal_chord_deviation_min_units: telemetry.horizontalChordDeviationMinUnits,
        vertical_chord_deviation_units: telemetry.verticalChordDeviationUnits,
        start_xyz: telemetry.start,
        end_xyz: telemetry.end,
      }} fields={[
        'status', 'terminal', 'start_sequence', 'end_sequence',
        'horizontal_delta_units', 'vertical_delta_units', 'forward_delta_units',
        'horizontal_chord_deviation_units', 'horizontal_chord_deviation_max_units',
        'horizontal_chord_deviation_min_units', 'vertical_chord_deviation_units',
        'start_xyz', 'end_xyz',
      ]} />
      <Drill label={`Raw XYZ sequence (${telemetry.samples?.length || 0} samples)`}>
        <pre style={{ margin: 0, maxHeight: 230, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 10, color: '#94a3b8' }}>
          {JSON.stringify(telemetry.samples || [], null, 2)}
        </pre>
      </Drill>
    </div>
  )
}

function PitchingCard({ pa, checks, interpretation }) {
  const pitches = pa.pitches || []
  const result = pa.result || null
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
  const strikes = countBy((pitch) => !BALL_PITCH_RESULTS.has(pitch.result))

  return (
    <Card title={<CheckHeader label="Pitching" status={checks?.pitching || 'pending'} />}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 7 }}>
        <Stat label="Pitcher" value={pa.pitcher_name} accent />
        <Stat label="Pitches" value={pitches.length} />
        <Stat label="Strikes" value={strikes} />
        <Stat label="Strike rate" value={pitches.length ? `${Math.round((strikes / pitches.length) * 100)}%` : null} />
        <Stat label="Top speed" value={speeds.length ? metric(Math.max(...speeds), 'mph') : null} />
        <Stat label="Telemetry" value={pitches.length ? `${pitches.filter((p) => p.pitch_telemetry).length}/${pitches.length}` : null} />
      </div>

      <div className="tc-scroll" tabIndex={0} role="group" aria-label="Pitches in this plate appearance, scrollable" style={{ marginTop: 10 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, minWidth: 480 }}>
          <thead>
            <tr style={{ color: '#94a3b8', textAlign: 'left' }}>
              {['#', 'Result', 'Offer', 'Type', 'Speed', 'Count', 'Pitch star', 'Batter star'].map((heading) => (
                <th key={heading} style={{ padding: '3px 8px 5px 0', fontWeight: 700 }}>{heading}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pitches.length ? pitches.map((pitch) => (
              <tr key={pitch.pitch_number_pa} style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
                <td style={{ padding: '4px 8px 4px 0' }}>{pitch.pitch_number_pa}</td>
                <td style={{ padding: '4px 8px 4px 0' }}>{formatPitchResultLabel(pitch.result)}</td>
                {/* Measured from the batter's own swing animation, which is the
                    only thing that separates a swinging strike from a called
                    one. A dash means no capture was running for this pitch. */}
                <td style={{ padding: '4px 8px 4px 0', color: pitch.offer ? '#f8fafc' : '#94a3b8' }}>{pitch.offer || '—'}</td>
                <td style={{ padding: '4px 8px 4px 0', color: pitch.pitch_type ? '#f8fafc' : '#f59e0b' }}>{pitch.pitch_type || 'unresolved'}</td>
                <td style={{ padding: '4px 8px 4px 0' }}>{metric(pitch.pitch_speed_mph, 'mph') || '—'}</td>
                <td style={{ padding: '4px 8px 4px 0', color: '#94a3b8' }}>
                  {pitch.count_balls_before}-{pitch.count_strikes_before} → {pitch.count_balls_after}-{pitch.count_strikes_after}
                </td>
                <td style={{ padding: '4px 8px 4px 0', color: pitch.is_star_pitch ? '#fde047' : '#94a3b8' }}>{pitch.is_star_pitch ? 'STAR' : '—'}</td>
                <td style={{ padding: '4px 8px 4px 0', color: pitch.is_star_swing ? '#fde047' : '#94a3b8' }}>{pitch.is_star_swing ? 'STAR' : '—'}</td>
              </tr>
            )) : (
              <tr><td colSpan={8} style={{ padding: '6px 0', color: '#94a3b8' }}>No pitches recorded yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {(pa.pitches_missing_from_log || []).length ? (
        <div style={{ marginTop: 8, padding: '6px 9px', borderRadius: 8, fontSize: 11,
          background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.4)', color: '#fbbf24' }}>
          The capture measured {pa.pitches_missing_from_log.length} pitch
          {pa.pitches_missing_from_log.length === 1 ? '' : 'es'} the tracker log never
          reported ({pa.pitches_measured} measured, {pa.pitches_logged} logged):{' '}
          {pa.pitches_missing_from_log.map((pitch) => (
            `${pitch.balls_before}-${pitch.strikes_before} ${pitch.offer}, ${pitch.outcome}`
          )).join('; ')}.
        </div>
      ) : null}

      <Drill label="Every pitching stat, and the per-pitch flight telemetry">
        <StatGroup title="Line charged to the pitcher" stats={[
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
          { label: 'Balls thrown', value: countBy((pitch) => pitch.result === 'ball') },
          { label: 'First-pitch strike', value: firstPitch ? !BALL_PITCH_RESULTS.has(firstPitch.result) : null },
          { label: 'Called strikes', value: countBy((pitch) => pitch.result === 'looking') },
          { label: 'Swinging misses', value: countBy((pitch) => pitch.result === 'swinging_miss') },
          { label: 'Unknown-swing strikes', value: countBy((pitch) => pitch.result === 'strike_unknown') },
          { label: 'Fouls', value: countBy((pitch) => pitch.result === 'foul') },
          { label: 'Balls in play', value: countBy((pitch) => pitch.result === 'in_play') },
        ]} />
        <StatGroup title="Pitch mix, velocity and stars" stats={[
          { label: 'Fastballs', value: typeCount('fastball') },
          { label: 'Curveballs', value: typeCount('curveball') },
          { label: 'Knuckleballs', value: typeCount('knuckleball') },
          { label: 'Changeups', value: typeCount('changeup') },
          { label: 'Unclassified', value: countBy((pitch) => !pitch.pitch_type) },
          { label: 'Avg pitch speed', value: speeds.length ? metric(speeds.reduce((total, value) => total + value, 0) / speeds.length, 'mph') : null },
          { label: 'Star pitches thrown', value: countBy((pitch) => pitch.is_star_pitch) },
          { label: 'Star pitch used', value: pa.star_pitch_used },
          {
            label: 'Star pitch ability',
            value: confirmedAbility(interpretation, 'pitch'),
            note: pa.star_pitch_used ? 'named only because the tracker announced it' : 'no star pitch announced',
          },
          { label: 'Star pitch successful', value: pa.star_pitch_successful },
        ]} />
        <div style={{ marginTop: 10 }}>
          {pitches.map((pitch) => (
            <div key={pitch.pitch_number_pa} style={{ padding: '9px 0', borderBottom: '1px solid rgba(255,255,255,0.08)', fontSize: 12 }}>
              <strong style={{ color: 'var(--gold)' }}>#{pitch.pitch_number_pa} {formatPitchResultLabel(pitch.result)}</strong>
              <PitchTelemetry pitch={pitch} />
            </div>
          ))}
        </div>
      </Drill>
    </Card>
  )
}

function BattingCard({ pa, contact, checks, projection, interpretation }) {
  const creditedHit = isCreditedHit(pa)
  const result = pa.result || null
  const runsOnPlay = pa.runs_scored || []
  return (
    <Card title={<CheckHeader label="Batting" status={checks?.batting || 'pending'} />}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 7 }}>
        <Stat label="Batter" value={pa.batter_name} accent />
        <Stat label="Result" value={result ? formatPaResultLabel(pa) : null} accent />
        <Stat label="Exit velocity" value={metric(pa.exit_velocity_mph, 'mph')} />
        <Stat label="Launch angle" value={metric(pa.launch_angle_deg, 'deg')} />
        <Stat
          label={projection?.is_projected ? 'Distance (projected)' : 'Distance (measured)'}
          value={metric(pa.hit_distance_ft, 'ft')}
          title={projection
            ? (DISTANCE_SOURCE_LABELS[projection.distance_source] || projection.distance_source)
            : undefined}
        />
        <Stat label="Trajectory" value={TRAJECTORY_LABELS[pa.trajectory] || pa.trajectory} />
      </div>
      {projection && (
        <div style={{
          marginTop: 8, padding: '6px 9px', borderRadius: 7, fontSize: 11,
          border: `1px solid ${projection.is_projected ? 'rgba(56, 189, 248, 0.5)' : 'rgba(74, 222, 128, 0.45)'}`,
          background: projection.is_projected ? 'rgba(56, 189, 248, 0.10)' : 'rgba(74, 222, 128, 0.08)',
          color: projection.is_projected ? '#7dd3fc' : '#86efac',
        }}>
          {DISTANCE_SOURCE_LABELS[projection.distance_source] || projection.distance_source}
        </div>
      )}

      <Drill label="Every batting stat and measurement">
        <StatGroup title="Result and scoring" stats={[
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
          // A throwing error is charged for the runner it advanced, so the
          // batter did NOT reach on it -- his hit stands.
          { label: 'Reached on error', value: pa.error_kind === 'throwing' ? false : pa.is_error },
          { label: "Fielder's choice", value: pa.fielder_choice_out },
          { label: 'Star swing used', value: pa.star_hit_used },
          { label: 'Star swing connected', value: pa.star_hit_used ? pa.star_hit_connected : null },
          {
            label: 'Star swing ability',
            value: confirmedAbility(interpretation, 'swing'),
            note: pa.star_hit_used ? 'named only because the tracker announced it' : 'no star swing announced',
          },
        ]} />
        <StatGroup title="Batted-ball measurements" stats={[
          { label: 'Spray angle', value: metric(pa.hit_angle_deg, 'deg'), accent: true },
          { label: 'Field zone', value: narrativeZone(interpretation), note: 'from the measured endpoint where one exists' },
          { label: 'Hang time', value: metric(pa.hang_time_sec, 'sec', 2) },
          { label: 'Spray side', value: SPRAY_SIDE_LABELS[contact?.spraySide] || contact?.spraySide },
          { label: 'Endpoint', value: contact?.endpoint },
          { label: 'Endpoint status', value: contact?.endpointStatus },
          { label: 'Distance source', value: projection?.distance_source },
          { label: 'Measured or projected', value: projection ? (projection.is_projected ? 'projected' : 'measured') : null },
          { label: 'Stadium', value: pa.hit_stadium_key },
        ]} />
        <StatGroup title="Situation" stats={[
          { label: 'PA number', value: pa.pa_number },
          { label: 'Inning', value: `${pa.half} ${pa.inning}` },
          { label: 'Outs before PA', value: pa.outs_before_pa },
          { label: 'Pitches seen', value: pa.pitches?.length ?? 0 },
          { label: 'Runner on 1st', value: pa.runner_on_first_before },
          { label: 'Runner on 2nd', value: pa.runner_on_second_before },
          { label: 'Runner on 3rd', value: pa.runner_on_third_before },
          { label: 'RISP chance', value: hasRispOpportunity(pa) },
        ]} />
        <Drill label="Landing / catch telemetry">
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
        </Drill>
      </Drill>
    </Card>
  )
}

function FieldingEventRow({ event }) {
  const contactTone = {
    confirmed: { color: '#4ade80', label: 'contact confirmed' },
    missed: { color: '#f87171', label: 'no contact' },
    unknown: { color: '#fbbf24', label: 'contact unknown' },
  }[event.ball_contact] || { color: '#94a3b8', label: String(event.ball_contact) }
  return (
    <div style={{
      padding: '7px 9px', borderRadius: 7, marginBottom: 6,
      border: '1px solid rgba(148,163,184,0.22)', background: 'rgba(15,23,42,0.5)',
    }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', alignItems: 'baseline' }}>
        <strong style={{ fontSize: 12 }}>{event.character || event.by}</strong>
        <span style={{ color: '#94a3b8', fontSize: 11 }}>{event.by}</span>
        <span style={{ color: '#64748b', fontSize: 10 }}>t={event.t}s · frame {event.frame}</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 5 }}>
        <TrackerPlayBadge label={event.fielding_attempt ? 'ATTEMPT' : 'NO ATTEMPT'} />
        <span style={{
          padding: '2px 7px', borderRadius: 5, fontSize: 10, fontWeight: 800,
          border: `1px solid ${contactTone.color}`, color: contactTone.color, background: `${contactTone.color}18`,
        }}>{contactTone.label}</span>
        <TrackerPlayBadge label={event.secured ? 'SECURED' : 'NOT SECURED'} />
        <TrackerPlayBadge label={`mechanic: ${event.mechanic}`} />
        <TrackerPlayBadge label={`action ${event.action_code}`} />
        {/* How the fielder reached the ball, from catch_type. The airborne
            flag is a leap and never a dive, so it cannot stand in for this. */}
        {event.dive && <TrackerPlayBadge label="DIVE" />}
        {event.leap && <TrackerPlayBadge label="LEAP" />}
      </div>
      <div className="muted" style={{ fontSize: 10, marginTop: 5 }}>
        official error: {String(event.official_error)} · confidence {event.confidence} · source {event.contact_source}
      </div>
    </div>
  )
}

function FieldingCard({ pa, play, checks, evidence, onLoadEvidence }) {
  const events = pa.fielding_events || {}
  const putouts = events.putouts || []
  const assists = events.assists || []
  const chain = parseFielderChainFromNotation(pa.hit_notation)
  const fullPlay = evidence?.play || null
  const fieldingEvents = fullPlay?.fielding_events || []

  return (
    <Card title={<CheckHeader label="Fielding" status={checks?.fielding || 'pending'} />}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 7 }}>
        <Stat label="Join" value={play?.join_status || 'none'}
          accent={play?.join_status !== 'joined'} note={play?.join_reason || undefined} />
        <Stat label="Primary fielder" value={play?.primary_fielder} accent />
        <Stat label="Why" value={play?.primary_fielder_reason} />
        <Stat label="First touch" value={play?.first_touch_character || play?.first_touch_by} />
        <Stat label="Caught in flight" value={play ? play.caught_in_flight : null} />
        <Stat label="Catch height" value={metric(play?.catch_height_units, 'u', 2)} />
        <Stat label="Attempts" value={play?.attempt_count ?? null} />
        <Stat label="Confirmed contacts" value={play?.confirmed_contacts ?? null} />
        <Stat label="Unknown contacts" value={play?.unknown_contacts ?? null} accent={Boolean(play?.unknown_contacts)} />
        <Stat label="Throws" value={play?.throw_count ?? null} />
        <Stat label="Putouts" value={putouts.length} />
        <Stat label="Assists" value={assists.length} />
      </div>
      {play?.badges?.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>
          {play.badges.map((badge) => <TrackerPlayBadge key={badge} label={badge} />)}
        </div>
      )}
      <p className="muted" style={{ margin: '8px 0 0', fontSize: 10 }}>
        A physical failure to secure the ball is never reported as an official scoring error —
        the capture observes possession, and the scorer&apos;s ruling is a different fact.
      </p>

      <Drill label="Every fielding attempt, route, throw and measurement" onOpen={onLoadEvidence}>
        {!fullPlay && (
          <p className="muted" style={{ margin: 0, fontSize: 11 }}>
            {play
              ? evidence?.error
                ? `Could not load the 60 Hz evidence: ${evidence.error}`
                : 'Loading the full 60 Hz evidence for this play…'
              : 'No 60 Hz play is joined to this at-bat, so there is no route, throw or contact evidence.'}
          </p>
        )}

        {fieldingEvents.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div style={{ color: '#cbd5e1', fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase', marginBottom: 6 }}>
              Attempts in chronological order
            </div>
            {fieldingEvents.map((event, index) => (
              <FieldingEventRow key={`${event.frame}-${index}`} event={event} />
            ))}
          </div>
        )}

        {fullPlay?.fielders && (
          <Drill label="Per-fielder routes, speeds and opportunity" open>
            <div className="tc-scroll" tabIndex={0} role="group" aria-label="Per-fielder routes, scrollable">
              <table className="tc-table" style={{ minWidth: 660 }}>
                <thead>
                  <tr style={{ color: '#94a3b8', textAlign: 'left' }}>
                    {['Pos', 'Character', 'Start at release', 'Path u', 'Displ u', 'Route eff', 'Sprint u/s', 'Glide u', 'Frozen s', 'Reaction s', 'To ball u', 'Hang s', 'Airborne f', 'Dive f'].map((h) => (
                      <th key={h} style={{ padding: '3px 7px 5px 0', fontWeight: 700 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(fullPlay.fielders).map(([position, entry]) => (
                    <tr key={position} style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
                      <td style={{ padding: '4px 7px 4px 0', color: entry.fielded ? '#fde047' : '#e2e8f0', fontWeight: entry.fielded ? 800 : 400 }}>{position}</td>
                      <td style={{ padding: '4px 7px 4px 0' }}>{entry.character || '—'}</td>
                      <td style={{ padding: '4px 7px 4px 0', color: '#94a3b8', fontSize: 10 }}>
                        {(entry.pitch_release_start || entry.start)
                          ? (entry.pitch_release_start || entry.start).map((value) => value.toFixed(1)).join(', ')
                          : '—'}
                      </td>
                      <td style={{ padding: '4px 7px 4px 0' }}>{metric(entry.path_units, '', 1) || '—'}</td>
                      <td style={{ padding: '4px 7px 4px 0' }}>{metric(entry.displacement_units, '', 1) || '—'}</td>
                      <td style={{ padding: '4px 7px 4px 0' }}>{metric(entry.route_efficiency, '', 3) || '—'}</td>
                      <td style={{ padding: '4px 7px 4px 0' }}>{metric(entry.sprint_speed_ups, '', 2) || '—'}</td>
                      <td style={{ padding: '4px 7px 4px 0', color: entry.assist_units ? '#fbbf24' : '#94a3b8' }}>{metric(entry.assist_units, '', 1) || '—'}</td>
                      {/* A frozen fielder cannot move, so route and reaction
                          two columns over are deliberately blank. This is the
                          column that says so. */}
                      <td style={{ padding: '4px 7px 4px 0', color: entry.frozen_seconds ? '#67e8f9' : '#94a3b8' }}>{metric(entry.frozen_seconds, '', 1) || '—'}</td>
                      <td style={{ padding: '4px 7px 4px 0' }}>{metric(entry.reaction_s, '', 3) || '—'}</td>
                      <td style={{ padding: '4px 7px 4px 0' }}>{metric(entry.distance_to_landing_units, '', 1) || '—'}</td>
                      <td style={{ padding: '4px 7px 4px 0' }}>{metric(entry.hang_time_s, '', 2) || '—'}</td>
                      <td style={{ padding: '4px 7px 4px 0' }}>{entry.airborne_frames ?? '—'}</td>
                      <td style={{ padding: '4px 7px 4px 0', color: entry.dove ? '#fde047' : '#94a3b8' }}>{entry.dive_frames || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted" style={{ margin: '6px 0 0', fontSize: 10 }}>
              Glide is distance the game moved the fielder rather than distance they ran; it is excluded from sprint speed.
            </p>
          </Drill>
        )}

        {fullPlay?.throws?.length > 0 && (
          <Drill label={`Throw chain (${fullPlay.throws.length})`} open>
            {fullPlay.throws.map((entry) => (
              <div key={entry.sequence} style={{ padding: '7px 0', borderBottom: '1px solid rgba(255,255,255,0.07)', fontSize: 11 }}>
                <strong>
                  #{entry.sequence} {entry.thrower_character || entry.thrower_position} ({entry.thrower_position})
                  {' → '}{entry.receiver_character || entry.receiver_position} ({entry.receiver_position})
                </strong>
                <div className="muted" style={{ fontSize: 10, marginTop: 3 }}>
                  target base {entry.target_base || '—'} · aimed at {entry.intended_target_position || '—'} ·
                  {' '}{metric(entry.peak_speed_mph, 'mph') || '— mph'} peak ·
                  {' '}release {entry.release_t}s → arrival {entry.arrival_t}s ·
                  {' '}outs {entry.outs_recorded} · relay {String(entry.is_relay)} ·
                  {' '}Buddy Throw {String(entry.buddy_throw)}
                  {entry.buddy_throw ? ` (partner ${entry.buddy_partner_position || '—'}, freeze ${entry.buddy_freeze_s}s)` : ''}
                </div>
                <div className="muted" style={{ fontSize: 10 }}>
                  quality: {entry.quality?.raw_speed_samples ?? '—'} usable samples,
                  {' '}{entry.quality?.discarded_speed_samples ?? '—'} discarded
                </div>
              </div>
            ))}
          </Drill>
        )}

        <StatGroup title="Credited fielding, errors and highlight plays" stats={[
          { label: 'Fielding notation', value: pa.hit_notation, accent: true },
          { label: 'Position chain', value: chain.length ? chain.map((position) => positionLabel(Number(position))).join(' → ') : null },
          { label: 'Putout fielders', value: nameList(putouts.map((putout) => putout.fielderName)) },
          { label: 'Runners retired', value: nameList(putouts.map((putout) => putout.runnerName)) },
          { label: 'Assist fielders', value: nameList(assists) },
          { label: 'Double play', value: pa.result ? pa.result === 'DP' : null },
          { label: 'Triple play', value: pa.result ? pa.result === 'TP' : null },
          { label: 'Official error charged', value: pa.is_error },
          {
            label: 'Error charged from',
            value: pa.error_kind === 'throwing' ? 'measured throw'
              : pa.error_kind === 'fielding' ? 'tracker bobble announcement' : null,
            note: pa.error_kind === 'throwing'
              ? 'the tracker log announced nothing; this is the capture’s own ruling'
              : null,
          },
          { label: 'Error notation', value: pa.error_notation },
          { label: 'Error position', value: positionLabel(pa.error_position) },
          { label: 'Error character', value: pa.error_character },
          { label: 'Physical bobble (tracker log)', value: events.bobble },
          { label: 'Buddy jump', value: pa.is_buddy_jump },
          { label: 'Buddy jump putout', value: positionLabel(pa.buddy_jump_putout_position) },
          { label: 'Buddy jump assist', value: positionLabel(pa.buddy_jump_assist_position) },
          { label: 'Robbed home run', value: pa.is_robbed_hr },
        ]} />

        {fullPlay && (
          <Drill label="Raw 60 Hz play record">
            <pre style={{ margin: 0, maxHeight: 420, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 10, color: '#cbd5e1' }}>
              {JSON.stringify(fullPlay, null, 2)}
            </pre>
          </Drill>
        )}
        {evidence?.postgame && (
          <Drill label="Postgame restatement (authoritative)">
            <pre style={{ margin: 0, maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 10, color: '#94a3b8' }}>
              {JSON.stringify(evidence.postgame, null, 2)}
            </pre>
          </Drill>
        )}
      </Drill>
    </Card>
  )
}

function BaserunningCard({ pa, play, checks, evidence, onLoadEvidence }) {
  const assignments = pa.runner_assignments || null
  const before = pa.runners_before || {}
  const fullPlay = evidence?.play || null
  const runners = fullPlay?.runners || null

  return (
    <Card title={<CheckHeader label="Baserunning" status={checks?.running || 'pending'} />}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 7 }}>
        <Stat label="On 1st before" value={before.first} />
        <Stat label="On 2nd before" value={before.second} />
        <Stat label="On 3rd before" value={before.third} />
        <Stat label="Home to first" value={metric(play?.home_to_first_s, 's', 3)} accent />
        <Stat label="90-foot split" value={metric(play?.ninety_foot_split_s, 's', 3)} />
        <Stat label="Runners resolved" value={assignments ? assignments.length : null}
          accent={!assignments} note={assignments ? 'exact base-by-base' : 'unresolved'} />
      </div>

      {assignments ? (
        <div className="tc-scroll" tabIndex={0} role="group" aria-label="Runner assignments, scrollable" style={{ marginTop: 9 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, minWidth: 380 }}>
            <thead>
              <tr style={{ color: '#94a3b8', textAlign: 'left' }}>
                {['Runner', 'From', 'To', 'Kind'].map((h) => (
                  <th key={h} style={{ padding: '3px 8px 5px 0', fontWeight: 700 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {assignments.map((assignment) => (
                <tr key={assignment.id} style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
                  <td style={{ padding: '4px 8px 4px 0' }}>{assignment.runner?.characterName}</td>
                  <td style={{ padding: '4px 8px 4px 0', color: '#94a3b8' }}>{assignment.isBatter ? 'plate' : assignment.origin}</td>
                  <td style={{
                    padding: '4px 8px 4px 0', fontWeight: 800,
                    color: assignment.destination === 'out' ? '#f87171'
                      : assignment.destination === 'home' ? '#4ade80' : '#e2e8f0',
                  }}>{assignment.destination}</td>
                  <td style={{ padding: '4px 8px 4px 0', color: '#64748b' }}>{assignment.isBatter ? 'batter-runner' : 'existing runner'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p style={{ margin: '9px 0 0', fontSize: 11, color: '#fbbf24' }}>
          Runner assignments are unresolved for this at-bat — the tracker did not establish where every
          runner finished. Flagged rather than guessed.
        </p>
      )}

      <Drill label="Every baserunning measurement" onOpen={onLoadEvidence}>
        {runners ? (
          <div className="tc-scroll" tabIndex={0} role="group" aria-label="Runner measurements, scrollable">
            <table className="tc-table" style={{ minWidth: 560 }}>
              <thead>
                <tr style={{ color: '#94a3b8', textAlign: 'left' }}>
                  {['Slot', 'Character', 'Bases ran', 'Sprint u/s', 'Lead u', 'Reaction s', 'Path u', 'Route eff', 'Stealing'].map((h) => (
                    <th key={h} style={{ padding: '3px 7px 5px 0', fontWeight: 700 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.entries(runners).map(([slot, entry]) => (
                  <tr key={slot} style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
                    <td style={{ padding: '4px 7px 4px 0' }}>{slot}</td>
                    <td style={{ padding: '4px 7px 4px 0' }}>{entry.character || '—'}</td>
                    <td style={{ padding: '4px 7px 4px 0' }}>{entry.bases_ran ?? '—'}</td>
                    <td style={{ padding: '4px 7px 4px 0' }}>{metric(entry.sprint_speed_ups, '', 2) || '—'}</td>
                    <td style={{ padding: '4px 7px 4px 0' }}>{metric(entry.lead_at_contact_units, '', 2) || '—'}</td>
                    <td style={{ padding: '4px 7px 4px 0' }}>{metric(entry.reaction_s, '', 3) || '—'}</td>
                    <td style={{ padding: '4px 7px 4px 0' }}>{metric(entry.path_units, '', 1) || '—'}</td>
                    <td style={{ padding: '4px 7px 4px 0' }}>{metric(entry.route_efficiency, '', 3) || '—'}</td>
                    <td style={{ padding: '4px 7px 4px 0' }}>{entry.stealing ? 'yes' : 'no'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Drill label="Five-foot splits">
              <pre style={{ margin: 0, fontSize: 10, color: '#94a3b8', whiteSpace: 'pre-wrap' }}>
                {JSON.stringify(Object.fromEntries(
                  Object.entries(runners).map(([slot, entry]) => [slot, entry.five_foot_splits_s || null]),
                ), null, 2)}
              </pre>
            </Drill>
          </div>
        ) : (
          <p className="muted" style={{ margin: 0, fontSize: 11 }}>
            {play ? 'Loading measured runner tracks…' : 'No 60 Hz play is joined to this at-bat.'}
          </p>
        )}
        <StatGroup title="Runs and outs" stats={[
          { label: 'Runs on play', value: (pa.runs_scored || []).length },
          { label: 'RBI', value: pa.rbi },
          { label: 'Outs on play', value: pa.outs_on_play },
          { label: 'Batter scored', value: pa.run_scored },
        ]} />
      </Drill>
    </Card>
  )
}

/**
 * Every 60 Hz play in the session, and how it joined.
 *
 * A full recorded game is a hundred-odd rows, and the rows worth looking at are
 * the handful that did not join cleanly. So the default view is those rows, and
 * "all" is one click away -- the reverse of what it was.
 */
function SessionPlayTable({ plays, onSelect, selectedPaNumber }) {
  const [showAll, setShowAll] = useState(false)
  const unclean = useMemo(
    () => plays.filter((play) => play.join_status && play.join_status !== 'joined'), [plays],
  )
  const rows = showAll || !unclean.length ? plays : unclean

  if (!plays.length) {
    return (
      <Card title="Every 60 Hz play this session, and how it joined">
        <p className="muted" style={{ margin: 0, fontSize: 11 }}>
          No 60 Hz plays yet. The collector emits one at each dead ball.
        </p>
      </Card>
    )
  }

  return (
    <Card
      title="Every 60 Hz play this session, and how it joined"
      action={unclean.length ? (
        <button type="button" className="tc-btn" aria-pressed={showAll}
          onClick={() => setShowAll((value) => !value)}>
          {showAll ? `Showing all ${plays.length}` : `Showing ${unclean.length} unclean of ${plays.length}`}
        </button>
      ) : null}
    >
      <div className="tc-scroll" tabIndex={0} role="group" aria-label="Every 60 Hz play in this session, scrollable">
        <table className="tc-table" style={{ minWidth: 700 }}>
          <caption>
            {rows.length} of {plays.length} plays
            {unclean.length ? ` · ${unclean.length} did not join cleanly` : ' · all joined cleanly'}
          </caption>
          <thead>
            <tr>
              {['Frame', 'Inn', 'Count', 'Batter', 'Class', 'Primary', 'Join', 'PA', 'Reason'].map((heading) => (
                <th key={heading} scope="col">{heading}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((play) => (
              <tr key={play.contact_timer}
                style={play.join_pa_number === selectedPaNumber
                  ? { background: 'rgba(250, 204, 21, 0.10)' } : undefined}>
                <th scope="row" style={{ position: 'static', background: 'none', color: '#64748b', fontWeight: 400 }}>
                  {play.contact_timer}
                </th>
                <td>{play.inning_half === 0 ? 'T' : 'B'}{play.inning}</td>
                <td style={{ color: '#94a3b8' }}>{play.count}</td>
                <td>{play.batter}</td>
                <td>{play.batted_ball_class}</td>
                <td>{play.primary_fielder || '—'}</td>
                <td style={{
                  fontWeight: 800,
                  color: play.join_status === 'joined' ? '#4ade80'
                    : play.join_status === 'pending' ? '#94a3b8' : '#f87171',
                }}>{play.join_status}</td>
                <td>
                  {play.join_pa_number == null ? '—' : (
                    <button type="button" className="tc-btn"
                      style={{ padding: '2px 8px', minHeight: 24, fontSize: 11 }}
                      onClick={() => onSelect(play.join_pa_number)}>
                      {play.join_pa_number}
                      <span className="tc-visually-hidden"> — open this plate appearance</span>
                    </button>
                  )}
                </td>
                <td style={{ color: '#64748b', fontSize: 10 }}>{play.join_reason || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

// --- 6. annotations ---------------------------------------------------------

function AnnotationPanel({ open, clause, onClose, onSubmit, pending, message, error }) {
  const [categories, setCategories] = useState([])
  const [note, setNote] = useState('')
  useEffect(() => {
    if (!open) return
    setCategories(clause?.metric ? ['wrong_measurement'] : [])
    setNote(clause?.metric
      ? `Metric: ${clause.metric.source}; tracked: ${clause.metric.value ?? 'missing'} ${clause.metric.unit}; observed: `
      : '')
  }, [open, clause])
  if (!open) return null

  const toggle = (value) => setCategories((current) => (
    current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value]
  ))

  return (
    <section className="panel" style={{ borderColor: '#f87171', background: 'rgba(248, 113, 113, 0.06)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
        <strong style={{ color: '#fca5a5', fontSize: 13 }}>Something is wrong</strong>
        <button type="button" onClick={onClose} style={{
          padding: '3px 9px', borderRadius: 6, fontSize: 11, cursor: 'pointer',
          border: '1px solid rgba(148,163,184,0.35)', background: 'transparent', color: '#cbd5e1',
        }}>Cancel</button>
      </div>
      {clause && (
        <div style={{ marginTop: 7, padding: '6px 9px', borderRadius: 7, background: 'rgba(15,23,42,0.6)', fontSize: 12 }}>
          <span className="muted" style={{ fontSize: 10 }}>Flagging this {clause.metric ? 'measurement' : 'clause'}:</span>
          <div style={{ color: '#e2e8f0' }}>{clause.text}</div>
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 9 }}>
        {ANNOTATION_CATEGORIES.map(([value, label]) => {
          const active = categories.includes(value)
          return (
            <button
              key={value}
              type="button"
              onClick={() => toggle(value)}
              style={{
                padding: '5px 10px', borderRadius: 999, fontSize: 11, fontWeight: 700, cursor: 'pointer',
                border: `1px solid ${active ? '#f87171' : 'rgba(148,163,184,0.35)'}`,
                background: active ? 'rgba(248,113,113,0.18)' : 'rgba(15,23,42,0.5)',
                color: active ? '#fca5a5' : '#cbd5e1',
              }}
            >{label}</button>
          )
        })}
      </div>
      <textarea
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="Optional — what actually happened?"
        rows={3}
        style={{
          width: '100%', marginTop: 9, padding: '7px 9px', borderRadius: 7, fontSize: 12,
          background: 'rgba(15,23,42,0.75)', color: '#f8fafc',
          border: '1px solid rgba(148,163,184,0.35)', resize: 'vertical',
        }}
      />
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 9, flexWrap: 'wrap' }}>
        <button
          type="button"
          disabled={pending || !categories.length}
          onClick={() => onSubmit({ categories, note, clauseId: clause?.id ?? null })}
          style={{
            padding: '7px 14px', borderRadius: 7, fontSize: 12, fontWeight: 800,
            cursor: pending || !categories.length ? 'default' : 'pointer',
            border: '1px solid rgba(248,113,113,0.6)',
            background: categories.length ? 'rgba(248,113,113,0.20)' : 'rgba(148,163,184,0.08)',
            color: categories.length ? '#fca5a5' : '#64748b',
          }}
        >{pending ? 'Saving…' : 'Save annotation'}</button>
        <span className="muted" style={{ fontSize: 10 }}>
          Pick at least one category. Text is optional. Saved beside the capture as JSONL —
          this never changes a statistic or a Supabase row.
        </span>
      </div>
      {message && <p style={{ margin: '7px 0 0', color: '#4ade80', fontSize: 11 }}>{message}</p>}
      {error && <p style={{ margin: '7px 0 0', color: '#f87171', fontSize: 11 }}>{error}</p>}
    </section>
  )
}

// --- 7. retained deep-dive panels ------------------------------------------

function StadiumSelector({ snapshot, onSelect, pending, error }) {
  const options = snapshot?.stadium_options || []
  const detected = snapshot?.stadium_detected_key || null
  const override = snapshot?.stadium_override_key || null
  const effective = snapshot?.stadium_key || null

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
      <select
        value={override || ''}
        onChange={(event) => onSelect(event.target.value || null)}
        disabled={pending || !options.length}
        style={{
          padding: '6px 9px', borderRadius: 7, fontSize: 12,
          background: 'rgba(15, 23, 42, 0.75)', color: '#f8fafc',
          border: '1px solid rgba(148, 163, 184, 0.35)', minWidth: 200,
        }}
      >
        <option value="">{detected ? `Auto — detected ${detected}` : 'Auto — nothing detected yet'}</option>
        {options.map((option) => (
          <option key={option.key} value={option.key}>{option.name}</option>
        ))}
      </select>
      {override && (
        <button type="button" onClick={() => onSelect(null)} disabled={pending} style={{
          padding: '6px 9px', borderRadius: 7, fontSize: 12, cursor: 'pointer',
          background: 'rgba(148, 163, 184, 0.12)', color: '#cbd5e1',
          border: '1px solid rgba(148, 163, 184, 0.35)',
        }}>Reset to auto</button>
      )}
      <span style={{ fontSize: 11, color: effective ? '#4ade80' : '#f59e0b' }}>
        {effective ? `Projecting against ${effective}` : 'No stadium — field location unavailable'}
      </span>
      {error && <span style={{ fontSize: 11, color: '#f87171' }}>{error}</span>}
    </div>
  )
}

function ProjectedLocation({ projection, contact }) {
  if (!projection) return <p className="muted" style={{ margin: 0 }}>Waiting for a batted-ball measurement.</p>
  const label = DISTANCE_SOURCE_LABELS[projection.distance_source] || projection.distance_source
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <div style={{
        padding: '9px 11px', borderRadius: 8, fontSize: 12,
        border: `1px solid ${projection.is_projected ? 'rgba(56, 189, 248, 0.5)' : 'rgba(74, 222, 128, 0.45)'}`,
        background: projection.is_projected ? 'rgba(56, 189, 248, 0.10)' : 'rgba(74, 222, 128, 0.08)',
        color: projection.is_projected ? '#7dd3fc' : '#86efac',
      }}>{label}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8 }}>
        <Measurement
          label={projection.distance_source === 'trajectory_projected_carry_from_collision' ? 'Projected distance' : 'Plotted distance'}
          value={formatMeasurement(projection.plotted_distance_ft, 'ft')} accent
        />
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
        impact_distance_ft: projection.impact_distance_ft,
        impact_height_ft: projection.impact_height_ft,
        physics_hang_time_sec: projection.physics_hang_time_sec,
        physics_x: projection.physics_x,
        physics_y: projection.physics_y,
        physics_minus_plotted_ft: projection.physics_vs_plotted_distance_ft,
      }} fields={[
        'endpoint', 'endpoint_status', 'distance_source', 'plot_source',
        'plot_angle_deg', 'launch_spray_angle_deg', 'stadium_key',
        'physics_distance_ft', 'impact_distance_ft', 'impact_height_ft',
        'physics_hang_time_sec', 'physics_x', 'physics_y', 'physics_minus_plotted_ft',
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
    </div>
  )
}

// --- the page ---------------------------------------------------------------

export default function TrackerLivePreview({
  baseUrl = DEFAULT_TRACKER_PREVIEW_BASE_URL,
  embedded = false,
  expectedGameId = null,
} = {}) {
  const service = useMemo(() => {
    const root = String(baseUrl || DEFAULT_TRACKER_PREVIEW_BASE_URL).replace(/\/+$/, '')
    return {
      state: `${root}/state`,
      play: `${root}/play`,
      annotations: `${root}/annotations`,
      pitchDiagnostics: `${root}/pitch-diagnostics`,
      stadium: `${root}/stadium`,
      landingCalibration: `${root}/landing-calibration`,
      shutdown: `${root}/shutdown`,
    }
  }, [baseUrl])

  const [snapshot, setSnapshot] = useState(null)
  const [connectionError, setConnectionError] = useState(null)
  const [stadiumPending, setStadiumPending] = useState(false)
  const [stadiumError, setStadiumError] = useState(null)
  const [calibrationMode, setCalibrationMode] = useState(false)
  const [calibrationSpot, setCalibrationSpot] = useState(null)
  const [calibrationPending, setCalibrationPending] = useState(false)
  const [calibrationMessage, setCalibrationMessage] = useState(null)
  const [calibrationError, setCalibrationError] = useState(null)
  // null follows the live at-bat; a number pins the page to that PA. The
  // default is to FOLLOW, but any click pins -- a completed at-bat must stay on
  // screen long enough to review.
  const [pinnedPaNumber, setPinnedPaNumber] = useState(null)
  const [evidence, setEvidence] = useState(null)
  const [annotationOpen, setAnnotationOpen] = useState(false)
  const [annotationClause, setAnnotationClause] = useState(null)
  const [annotationPending, setAnnotationPending] = useState(false)
  const [annotationMessage, setAnnotationMessage] = useState(null)
  const [annotationError, setAnnotationError] = useState(null)
  const [annotationCount, setAnnotationCount] = useState(null)
  const [shutdownPending, setShutdownPending] = useState(false)
  const [shutdownRequested, setShutdownRequested] = useState(false)
  const [shutdownMessage, setShutdownMessage] = useState(null)
  const [atBatFilter, setAtBatFilter] = useState('all')
  // The capture-health detail is collapsed by default and blockers are not:
  // an operator should not have to open anything to learn the capture is dead.
  const [healthOpen, setHealthOpen] = useState(false)
  const [announcement, setAnnouncement] = useState('')

  // When the last successful poll happened, which is what separates a dropped
  // request from a page that has been showing frozen numbers for an inning.
  const [lastGoodAt, setLastGoodAt] = useState(null)
  const [feedClock, setFeedClock] = useState(() => Date.now())

  useEffect(() => {
    if (shutdownRequested) return undefined
    let cancelled = false
    let timer = null
    // The signature of the snapshot currently on screen. A full recorded game
    // serializes to 200-250 KB, and swapping that object twice a second
    // re-rendered ninety-eight at-bat buttons, a hundred-row play table and the
    // whole diagram whether or not one byte of it had changed. `revision` is
    // bumped by every state mutation the service makes, so an unchanged
    // revision means an unchanged snapshot -- except for the frame age, which
    // is computed at serialization time and is therefore kept live to the
    // second on its own.
    let signature = null
    async function refresh() {
      let nextPollMs = 500
      try {
        const url = pinnedPaNumber == null ? service.state : `${service.state}?at_bat=${pinnedPaNumber}`
        const response = await fetch(url, { cache: 'no-store' })
        const next = await response.json().catch(() => null)
        if (!response.ok) {
          throw new Error(next?.error || `Preview service returned ${response.status}`)
        }
        if (!cancelled) {
          const ageBucket = next?.capture?.last_frame_age_ms == null
            ? 'none' : Math.round(next.capture.last_frame_age_ms / 1000)
          const nextSignature = `${next?.revision}:${next?.selected_pa_number}:${ageBucket}`
                              + `:${next?.at_bat_count}:${next?.tracker_status}`
          if (nextSignature !== signature) {
            signature = nextSignature
            setSnapshot(next)
          }
          setLastGoodAt(Date.now())
          setConnectionError(null)
        }
      } catch (error) {
        // A dead API should be visible, but a stale tab does not need to hammer
        // Vite twice per second forever. Successful sessions still poll at 2 Hz.
        nextPollMs = 3000
        if (!cancelled) setConnectionError(error.message)
      } finally {
        if (!cancelled) timer = setTimeout(refresh, nextPollMs)
      }
    }
    refresh()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [pinnedPaNumber, service, shutdownRequested])

  // A stale banner has to age on its own: once polling stops succeeding there
  // is nothing left to drive a re-render, and a page that froze silently is the
  // exact failure this is here to make visible.
  useEffect(() => {
    if (!connectionError || shutdownRequested) return undefined
    const timer = setInterval(() => setFeedClock(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [connectionError, shutdownRequested])

  const atBats = useMemo(() => snapshot?.at_bats || [], [snapshot])
  const trackingPlays = useMemo(() => snapshot?.player_tracking_plays || [], [snapshot])

  // Every at-bat with the four filter facts attached. Derived once per snapshot
  // rather than per keystroke: this is O(at-bats x plays) and a full game is
  // ninety-eight by a hundred and ten.
  const annotatedAtBats = useMemo(
    () => annotateAtBats(atBats, trackingPlays), [atBats, trackingPlays],
  )
  const filterCounts = useMemo(() => countAtBatFilters(annotatedAtBats), [annotatedAtBats])
  const visibleAtBats = useMemo(
    () => filterAtBats(annotatedAtBats, atBatFilter), [annotatedAtBats, atBatFilter],
  )

  useEffect(() => {
    if (pinnedPaNumber == null) return
    if (!atBats.some((entry) => entry.pa_number === pinnedPaNumber)) setPinnedPaNumber(null)
  }, [atBats, pinnedPaNumber])

  const selectAtBat = useCallback((paNumber) => setPinnedPaNumber(paNumber), [])
  const followLive = useCallback(() => setPinnedPaNumber(null), [])

  // WHERE THE SELECTION LIVES. The snapshot's selected_pa_number lags by up to
  // one poll, so reading it as the anchor meant five arrow presses in a second
  // all computed the same target and the page moved ONE at-bat. The local pin
  // is authoritative the instant it is set; the snapshot answers only while
  // the page is following the live at-bat.
  const selectedPaNumber = pinnedPaNumber ?? snapshot?.selected_pa_number ?? null

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      const target = event.target
      if (target instanceof HTMLElement && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return
      const selected = selectedPaNumber
      // Shift jumps to the next at-bat that needs looking at; the plain arrow
      // steps through whatever the filter is currently showing.
      const next = event.shiftKey
        ? findNextMatch(annotatedAtBats, selected,
          (entry) => entry.has_warnings, event.key === 'ArrowLeft' ? -1 : 1)
        : stepSelection(visibleAtBats, selected, event.key === 'ArrowLeft' ? -1 : 1)
      if (next == null) return
      event.preventDefault()
      setPinnedPaNumber(next)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [annotatedAtBats, visibleAtBats, selectedPaNumber])

  const pa = snapshot?.display_at_bat || null
  const projection = pa?.preview_projection || null
  const contact = pa?.advanced_batted_ball_raw || null
  const displayPlay = snapshot?.display_play || null
  const interpretation = snapshot?.interpretation || null
  const warnings = snapshot?.warnings || []
  const checks = snapshot?.checks || null
  const isLive = snapshot?.writes_enabled === true
  const tally = useMemo(() => writeTally(atBats, isLive), [atBats, isLive])

  const gameMismatch = Boolean(
    expectedGameId != null
    && snapshot?.game?.game_id != null
    && String(snapshot.game.game_id) !== String(expectedGameId),
  )

  // The three things every panel below is conditioned on, derived once.
  const feed = useMemo(() => describeFeedStatus({
    snapshot, connectionError, lastGoodAt, now: feedClock, shutdownRequested,
  }), [snapshot, connectionError, lastGoodAt, feedClock, shutdownRequested])
  const header = useMemo(() => buildGameHeader(snapshot), [snapshot])
  const health = useMemo(() => summarizeCaptureHealth(snapshot, {
    feed, gameMismatch, expectedGameId, atBats,
  }), [snapshot, feed, gameMismatch, expectedGameId, atBats])
  const explanation = useMemo(() => buildPlayExplanation({
    interpretation, play: displayPlay, atBat: pa, warnings,
  }), [interpretation, displayPlay, pa, warnings])

  // Losing the feed and getting it back are both events, and neither used to
  // be announced anywhere -- the page simply resumed as though nothing had
  // happened, which is the same thing it did when nothing had.
  const previousFeedState = useRef(feed.state)
  useEffect(() => {
    if (feedRecovered(previousFeedState.current, feed.state)) {
      setAnnouncement('Reconnected to the tracker service. The snapshot below is live again.')
      const timer = setTimeout(() => setAnnouncement(''), 6000)
      previousFeedState.current = feed.state
      return () => clearTimeout(timer)
    }
    if (previousFeedState.current !== feed.state) {
      if (feed.state === 'stale') setAnnouncement('The tracker feed has stopped. Showing the last good snapshot.')
      previousFeedState.current = feed.state
    }
    return undefined
  }, [feed.state])

  // Heavy evidence is fetched on demand, never polled.
  useEffect(() => { setEvidence(null) }, [pa?.pa_number])
  const loadEvidence = useCallback(async () => {
    const timer = displayPlay?.contact_timer
    if (timer == null) return
    try {
      const response = await fetch(`${service.play}?contact_timer=${timer}`, { cache: 'no-store' })
      if (!response.ok) throw new Error(`Preview service returned ${response.status}`)
      setEvidence(await response.json())
    } catch (error) {
      setEvidence({ error: error.message })
    }
  }, [displayPlay?.contact_timer, service])

  useEffect(() => {
    setCalibrationMode(false)
    setCalibrationSpot(null)
    setCalibrationMessage(null)
    setCalibrationError(null)
    setAnnotationOpen(false)
    setAnnotationMessage(null)
    setAnnotationError(null)
  }, [pa?.pa_number])

  useEffect(() => {
    let cancelled = false
    fetch(service.annotations, { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => { if (!cancelled && body) setAnnotationCount(body.count) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [service, annotationMessage])

  const selectStadium = async (stadiumKey) => {
    setStadiumPending(true)
    setStadiumError(null)
    try {
      const url = pinnedPaNumber == null ? service.stadium : `${service.stadium}?at_bat=${pinnedPaNumber}`
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

  const stopPreview = async () => {
    if (shutdownPending || shutdownRequested) return
    if (!window.confirm('Save the raw capture, end this tracker session, and run the authoritative derivation?')) return
    setShutdownPending(true)
    try {
      const response = await fetch(service.shutdown, { method: 'POST' })
      const body = await response.json()
      if (!response.ok) throw new Error(body?.error || `Preview service returned ${response.status}`)
      setShutdownRequested(true)
      setShutdownMessage('Capture is saving. This page will stop updating when derivation finishes; watch the terminal for the final file path.')
    } catch (error) {
      setShutdownMessage(`Could not end the session: ${error.message}`)
    } finally {
      setShutdownPending(false)
    }
  }

  const openAnnotation = useCallback((clause) => {
    setAnnotationClause(clause || null)
    setAnnotationOpen(true)
    setAnnotationMessage(null)
    setAnnotationError(null)
  }, [])

  const submitAnnotation = useCallback(async ({ categories, note, clauseId }) => {
    if (!pa?.pa_number) return
    setAnnotationPending(true)
    setAnnotationError(null)
    setAnnotationMessage(null)
    try {
      const response = await fetch(service.annotations, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pa_number: pa.pa_number,
          categories,
          note,
          clause_id: clauseId,
          play_contact_timer: displayPlay?.contact_timer ?? null,
        }),
      })
      const saved = await response.json()
      if (!response.ok) throw new Error(saved?.error || `Preview service returned ${response.status}`)
      setAnnotationOpen(false)
      setAnnotationMessage(`Flagged PA ${saved.pa_number} (${saved.categories.join(', ')}) → ${saved.path}`)
    } catch (error) {
      setAnnotationError(error.message)
    } finally {
      setAnnotationPending(false)
    }
  }, [pa?.pa_number, displayPlay?.contact_timer, service])

  const landingSpot = useMemo(() => (
    pa?.hit_x != null && pa?.hit_y != null ? { x: pa.hit_x, y: pa.hit_y } : null
  ), [pa])
  const fieldedSpot = useMemo(() => (
    pa?.fielded_x != null && pa?.fielded_y != null ? { x: pa.fielded_x, y: pa.fielded_y } : null
  ), [pa])

  const recordLandingCalibration = async (spot) => {
    if (!pa?.pa_number || calibrationPending) return
    setCalibrationSpot(spot)
    setCalibrationPending(true)
    setCalibrationError(null)
    setCalibrationMessage(null)
    try {
      const response = await fetch(`${service.landingCalibration}?at_bat=${pa.pa_number}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image_x: spot.x, image_y: spot.y }),
      })
      const saved = await response.json()
      if (!response.ok) throw new Error(saved?.error || `Preview service returned ${response.status}`)
      setCalibrationMode(false)
      setCalibrationMessage(saved.projected
        ? `Saved ${saved.batter || 'hit'}: projection was ${saved.automatic_image_x?.toFixed?.(1) ?? '?'}%, `
          + `${saved.automatic_image_y?.toFixed?.(1) ?? '?'}% → marked (${saved.image_x.toFixed(1)}%, ${saved.image_y.toFixed(1)}%)`
        : `Saved ${saved.batter || 'hit'}: world (${saved.x.toFixed(2)}, ${saved.y.toFixed(2)}, ${saved.z.toFixed(2)}) → image (${saved.image_x.toFixed(1)}%, ${saved.image_y.toFixed(1)}%)`)
    } catch (error) {
      setCalibrationError(error.message)
    } finally {
      setCalibrationPending(false)
    }
  }

  const sessionHits = useMemo(() => atBats
    .filter((entry) => entry.hit_world_x != null && entry.hit_world_z != null)
    .map((entry) => ({ ...entry, id: null, is_selected: entry.pa_number === selectedPaNumber })),
  [atBats, selectedPaNumber])

  const displayWrite = pa?.supabase_write || null

  return (
    <div className={`tc-console${embedded ? '' : ' page'}`}>
      <a className="tc-skip-link" href="#tc-main">Skip to the play</a>
      {/* Feed transitions are events. Without a live region they happened in
          silence for anyone not watching the colour of a chip. */}
      <div className="tc-live-region" role="status" aria-live="polite">{announcement}</div>

      <GameHeader
        snapshot={snapshot}
        header={header}
        health={health}
        feed={feed}
        gameMismatch={gameMismatch}
        expectedGameId={expectedGameId}
        baseUrl={baseUrl}
        onStop={snapshot && ['local_preview', 'archive_replay'].includes(snapshot.mode) ? stopPreview : null}
        stopPending={shutdownPending}
        stopMessage={shutdownMessage}
        healthOpen={healthOpen}
        onToggleHealth={() => setHealthOpen((open) => !open)}
        reviewing={pinnedPaNumber}
      />

      {/* STARTUP. Three different waits used to render as the same blank page:
          no service, a service with no game yet, and a game with no play yet.
          Each one has a different next action, so each one says what it is. */}
      {!snapshot && !connectionError && (
        <section className="panel" id="tc-main">
          <strong>Waiting for a tracker service on {baseUrl}</strong>
          <p className="muted" style={{ margin: '5px 0 0', fontSize: 12 }}>
            Run <code>npm run tracker:preview</code>. It starts this page, the tracker, the
            60 Hz collector and the local API together without writing to Supabase.
          </p>
          <p className="muted" style={{ margin: '5px 0 0', fontSize: 12 }}>
            To review a recorded session instead:{' '}
            <code>npm run tracker:replay -- --session data/player_tracking/&lt;stem&gt;</code>
          </p>
        </section>
      )}

      {!snapshot && connectionError && (
        <section className="panel" style={{ borderColor: '#ef4444' }} id="tc-main">
          <strong style={{ color: '#f87171' }}>No tracker service is answering on {baseUrl}</strong>
          <p className="muted" style={{ margin: '5px 0 0', fontSize: 12 }}>{connectionError}</p>
          <p className="muted" style={{ margin: '5px 0 0', fontSize: 12 }}>
            The page keeps retrying every 3 seconds and will fill in the moment the service answers.
          </p>
        </section>
      )}

      {snapshot && !snapshot.capture && (
        <section className="panel" style={{ borderColor: '#f59e0b' }}>
          <strong style={{ color: '#f59e0b' }}>This tracker service predates the validation console</strong>
          <p className="muted" style={{ margin: '5px 0 0', fontSize: 12 }}>
            The service on {baseUrl} does not report capture health or player-tracking plays. Restart it
            to get the interpretation, join status and 60 Hz evidence.
          </p>
        </section>
      )}

      <div className={`tc-workspace${atBats.length ? '' : ' tc-workspace--empty'}`}>
      {atBats.length > 0 && (
        <AtBatHistory
          atBats={visibleAtBats}
          allAtBats={annotatedAtBats}
          selectedPaNumber={selectedPaNumber}
          following={pinnedPaNumber == null}
          onSelect={selectAtBat}
          onFollowLive={followLive}
          isLive={isLive}
          filter={atBatFilter}
          onFilter={setAtBatFilter}
          counts={filterCounts}
        />
      )}

      <div className="tc-review-column">
      {!pa ? (
        snapshot ? (
          <section className="panel" id="tc-main">
            <strong>
              {header.matchup.batter
                ? 'Waiting for the first tracked play'
                : 'Waiting for the first matchup'}
            </strong>
            <p className="muted" style={{ margin: '6px 0 0', fontSize: 12 }}>
              {header.matchup.batter
                ? `The tracker has ${header.matchup.batter} at the plate against `
                  + `${header.matchup.pitcher || 'an unknown pitcher'}. A plate appearance appears here `
                  + 'as soon as it produces a pitch or a batted ball.'
                : isLive
                  ? 'The bridge is connected to this game. Leave Dolphin running and begin a plate appearance.'
                  : 'Leave Dolphin running and begin a plate appearance. The stadium is read from '
                    + 'game memory automatically.'}
            </p>
            {/* What the operator can check while nothing is happening. A blank
                "waiting" panel gave them nothing to act on. */}
            <ul className="muted" style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12 }}>
              <li>
                Collector: <strong style={{ color: '#e2e8f0' }}>{snapshot.capture?.status || 'unknown'}</strong>
                {snapshot.capture?.collector_pid ? ` (pid ${snapshot.capture.collector_pid})` : ''}
              </li>
              <li>
                Stadium: <strong style={{ color: '#e2e8f0' }}>{header.park.label || 'not resolved yet'}</strong>
              </li>
              <li>
                60 Hz plays derived so far:{' '}
                <strong style={{ color: '#e2e8f0' }}>{snapshot.capture?.play_count ?? 0}</strong>
              </li>
            </ul>
          </section>
        ) : null
      ) : (
        <>
          <SelectedPlayHeader
            pa={pa}
            checks={checks}
            currentPaNumber={snapshot?.current_at_bat?.pa_number}
            pinned={pinnedPaNumber != null}
            onFlag={() => openAnnotation(null)}
            isLive={isLive}
            write={displayWrite}
          />

          <div className="tc-primary-review">
            <Card title="Measured field view" className="tc-diagram-card">
              <TrackerPlayDiagram
                stadiumKey={snapshot?.stadium_key}
                geometry={snapshot?.play_geometry}
                badges={[]}
                height={700}
              />
            </Card>
            <div className="tc-review-sidebar">
              <PlayReviewSummary
                pa={pa}
                play={displayPlay}
                explanation={explanation}
                warnings={warnings}
                advancedMetrics={snapshot?.advanced_metrics}
                projection={projection}
              />
              <InterpretationPanel interpretation={interpretation} atBat={pa} onFlag={openAnnotation} />
            </div>
          </div>

          <AnnotationPanel
            open={annotationOpen}
            clause={annotationClause}
            onClose={() => setAnnotationOpen(false)}
            onSubmit={submitAnnotation}
            pending={annotationPending}
            message={null}
            error={annotationError}
          />
          {annotationMessage && (
            <section className="panel" style={{ borderColor: 'rgba(74,222,128,0.45)', padding: '8px 12px' }}>
              <span style={{ color: '#4ade80', fontSize: 11 }}>{annotationMessage}</span>
              {annotationCount != null && (
                <span className="muted" style={{ fontSize: 10, marginLeft: 8 }}>
                  {annotationCount} annotation{annotationCount === 1 ? '' : 's'} in this session file
                </span>
              )}
            </section>
          )}

          <TrackerAdvancedMetrics metrics={snapshot?.advanced_metrics} onFlag={openAnnotation} />

          <details className="panel tc-detail-panel">
            <summary>
              <span>Scoring, pitches, fielding & baserunning</span>
              <ChecksGlyphs checks={checks} />
            </summary>
          <div className="tc-cards tc-detail-cards">
            <PitchingCard pa={pa} checks={checks} interpretation={interpretation} />
            <BattingCard
              pa={pa} contact={contact} checks={checks}
              projection={projection} interpretation={interpretation}
            />
            <FieldingCard
              pa={pa} play={displayPlay} checks={checks}
              evidence={evidence} onLoadEvidence={loadEvidence}
            />
            <BaserunningCard
              pa={pa} play={displayPlay} checks={checks}
              evidence={evidence} onLoadEvidence={loadEvidence}
            />
          </div>
          </details>

          <Drill label="Stadium, field artwork, spray chart and projection">
            <div style={{ display: 'grid', gap: 12 }}>
              <Card title="Stadium">
                <StadiumSelector snapshot={snapshot} onSelect={selectStadium} pending={stadiumPending} error={stadiumError} />
                {snapshot?.stadium_name && (
                  <p className="muted" style={{ margin: '8px 0 0', fontSize: 11 }}>
                    Tracker reported stadium: {snapshot.stadium_name}
                    {snapshot.stadium_override_key ? ' (overridden by your selection)' : ''}
                  </p>
                )}
              </Card>

              <div className="tc-cards">
                <Card title="Field location (park artwork)">
                  {pa.hit_stadium_key ? (
                    <>
                      {((contact?.x != null && contact?.y != null && contact?.z != null)
                        || (pa?.hit_world_x != null && pa?.hit_world_z != null)) && (
                        <div style={{ marginBottom: 9 }}>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, alignItems: 'center' }}>
                            <button
                              type="button"
                              onClick={() => {
                                setCalibrationMode((active) => !active)
                                setCalibrationError(null)
                                setCalibrationMessage(null)
                              }}
                              disabled={calibrationPending}
                              style={{
                                padding: '6px 10px', borderRadius: 7, fontSize: 11, fontWeight: 800,
                                cursor: calibrationPending ? 'default' : 'pointer',
                                border: `1px solid ${calibrationMode ? '#fb923c' : 'rgba(251,146,60,0.5)'}`,
                                color: calibrationMode ? '#0f172a' : '#fdba74',
                                background: calibrationMode ? '#fb923c' : 'rgba(251,146,60,0.10)',
                              }}
                            >
                              {calibrationPending ? 'Saving…' : calibrationMode ? 'Cancel impact mark'
                                : projection?.is_projected ? 'Mark actual landing' : 'Mark actual impact'}
                            </button>
                            {calibrationMode && (
                              <strong style={{ color: '#fdba74', fontSize: 11 }}>
                                {projection?.is_projected
                                  ? 'Click where the ball actually came down'
                                  : 'Click the exact landmark the ball struck'}
                              </strong>
                            )}
                          </div>
                          {calibrationMessage && <p style={{ margin: '6px 0 0', color: '#4ade80', fontSize: 10 }}>{calibrationMessage}</p>}
                          {calibrationError && <p style={{ margin: '6px 0 0', color: '#f87171', fontSize: 10 }}>{calibrationError}</p>}
                          <p className="muted" style={{ margin: '5px 0 0', fontSize: 10 }}>
                            Calibration clicks are written only to the tracker service&apos;s own log; they never
                            change statistics, the stored at-bat, or the active map.
                          </p>
                        </div>
                      )}
                      <FieldPlayBuilder
                        stadiumKey={pa.hit_stadium_key}
                        landingSpot={calibrationSpot || landingSpot}
                        onFieldTap={calibrationMode ? recordLandingCalibration : undefined}
                        secondarySpot={calibrationSpot ? landingSpot : fieldedSpot}
                        primaryMarkerLabel={calibrationSpot ? 'Marked actual impact'
                          : projection?.is_projected ? 'Projected landing (no tracked landing)' : 'First landing / catch'}
                        secondaryMarkerLabel={calibrationSpot ? 'Current automatic placement' : 'Fielded'}
                        label=""
                        showFielderMarkers={false}
                        allowFielderSelection={false}
                      />
                    </>
                  ) : (
                    <p className="muted">
                      {snapshot?.stadium_key ? 'Waiting for a batted-ball location.' : 'Pick a stadium to project the batted-ball location.'}
                    </p>
                  )}
                </Card>

                <Card title="Session spray chart (measured geometry)">
                  {hasMeasuredGeometry(snapshot?.stadium_key) ? (
                    <>
                      <VectorSprayChart plateAppearances={sessionHits} initialStadiumKey={snapshot?.stadium_key} height={400} />
                      <p className="muted" style={{ margin: '8px 0 0', fontSize: 11 }}>
                        {sessionHits.length} tracked hit{sessionHits.length === 1 ? '' : 's'} this session ·
                        measured fence · 1 unit = 1 m ({FEET_PER_UNIT.toFixed(3)} ft)
                      </p>
                    </>
                  ) : (
                    <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                      {snapshot?.stadium_key
                        ? `${String(snapshot.stadium_key).replace(/_/g, ' ')} has not been measured yet.`
                        : 'Pick a stadium above.'}
                    </p>
                  )}
                </Card>
              </div>

              <Card title="Projected landing (X-Y)">
                <ProjectedLocation projection={projection} contact={contact} />
              </Card>
            </div>
          </Drill>

          <Drill label={isLive
            ? 'Session data, raw JSON and Supabase state'
            : 'Session data, raw JSON and local diagnostics'}>
            <div style={{ display: 'grid', gap: 12 }}>
              {isLive && (
                <Card title="Saved to Supabase">
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 10px', alignItems: 'center', marginBottom: 8 }}>
                    <WriteStatusBadge write={displayWrite} isCurrent={pa.pa_number === snapshot?.current_at_bat?.pa_number} />
                    {tally && (
                      <span style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap', fontSize: 11 }}>
                        <span style={{ color: '#4ade80', fontWeight: 800 }}>{tally.written} saved</span>
                        <span style={{ color: tally.skipped ? '#fbbf24' : '#64748b', fontWeight: 800 }}>{tally.skipped} not saved</span>
                        <span style={{ color: tally.failed ? '#f87171' : '#64748b', fontWeight: 800 }}>{tally.failed} failed</span>
                      </span>
                    )}
                  </div>
                  {displayWrite?.reason && (
                    <p style={{ margin: '0 0 8px', fontSize: 11, color: displayWrite.status === 'failed' ? '#fca5a5' : '#fcd34d' }}>
                      {displayWrite.reason}
                    </p>
                  )}
                  <Rows object={{
                    status: displayWrite?.status ?? null,
                    pa_id: displayWrite?.pa_id ?? null,
                    pa_number_db: displayWrite?.pa_number_db ?? null,
                    result_written: displayWrite?.result ?? null,
                    pitch_rows: displayWrite?.pitch_rows ?? null,
                    run_rows: displayWrite?.run_rows ?? null,
                    recorded_at: displayWrite?.recorded_at ?? null,
                  }} fields={['status', 'pa_id', 'pa_number_db', 'result_written', 'pitch_rows', 'run_rows', 'recorded_at']} />
                  <p className="muted" style={{ margin: '8px 0 0', fontSize: 10 }}>
                    &quot;Not saved&quot; is a deliberate refusal, not a crash — the bridge never guesses a
                    result it could not read.
                  </p>
                </Card>
              )}

              <SessionPlayTable plays={trackingPlays} onSelect={selectAtBat}
                selectedPaNumber={selectedPaNumber} />

              <Card title="Session pitch diagnostics">
                <a href={service.pitchDiagnostics} style={{
                  display: 'inline-block', padding: '7px 10px', borderRadius: 7,
                  border: '1px solid rgba(250, 204, 21, 0.55)', background: 'rgba(250, 204, 21, 0.10)',
                  color: '#fde047', fontSize: 12, fontWeight: 800,
                }}>Download session pitch diagnostics</a>
                <span className="muted" style={{ fontSize: 11, marginLeft: 9 }}>
                  {snapshot?.session_pitch_diagnostics?.pitch_count || 0} pitches across{' '}
                  {snapshot?.session_pitch_diagnostics?.at_bat_count || 0} at-bats.
                </span>
              </Card>

              <Card title="Raw in-memory at-bat JSON">
                <pre style={{ margin: 0, maxHeight: 560, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 10, color: '#cbd5e1' }}>
                  {JSON.stringify(pa, null, 2)}
                </pre>
              </Card>

              <Card title="Recent tracker lines">
                <pre style={{ margin: 0, maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 10, color: '#94a3b8' }}>
                  {(snapshot?.recent_tracker_messages || []).slice(-60).join('\n')}
                </pre>
              </Card>

              <Card title="Collector / memory diagnostics">
                <pre style={{ margin: 0, maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: 10, color: '#94a3b8' }}>
                  {(snapshot?.capture?.recent_messages || []).slice(-60).join('\n')
                    || 'Waiting for the first live matchup. The collector will start automatically.'}
                </pre>
              </Card>
            </div>
          </Drill>
        </>
      )}
      </div>
      </div>
    </div>
  )
}
