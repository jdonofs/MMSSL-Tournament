import { useEffect, useMemo, useRef, useState } from 'react'
import {
  FEET_PER_UNIT,
  HOME_PLATE,
  PARK_FENCES,
  fenceRadiusAt,
  hasMeasuredGeometry,
  infieldCorners,
  parkMaxRadius,
} from '../utils/parkGeometry'
import {
  PADDING,
  VIEW_HEIGHT,
  VIEW_WIDTH,
  describePlayGeometry,
  placeLabels,
} from '../utils/trackerDiagramLayout'

// The play as it actually happened, drawn from measured coordinates.
//
// Everything on this diagram is in the game's own ball-frame units and is drawn
// through one similarity transform -- scale and translate, nothing fitted -- so
// a fielder is exactly where the capture says they were relative to a fence
// that was measured rather than eyeballed. That matters for the one question
// this diagram exists to answer: does the tracker's sentence about this play
// match the geometry of the play? A fielder drawn onto stadium artwork through
// a hand-tuned projection cannot answer it, because a disagreement could always
// be the projection.
//
// WHAT IS DRAWN, AND WHAT EACH MARK MEANS
//   · the measured fence and the infield diamond          park geometry
//   · four base plates                                    park geometry
//   · nine hollow markers                                 fielders at pitch release
//   · a solid line from a marker                          that fielder's route
//   · the flight line from home to the endpoint           the batted ball
//   · a hollow ring at the endpoint                       landed
//   · a filled ring at the endpoint                       caught in flight
//   · a cross                                             a fielding contact event
//   · arrows between markers                              the throw chain
//
// Nothing is drawn that was not measured. In particular there is no dive arc
// and no "attempted range" halo, because neither is in the data.
//
// A MARKER IS NEVER MOVED TO MAKE ROOM. Two fielders standing on top of each
// other is a fact about the play and the diagram has to show it. When labels
// would collide it is the LABEL that is displaced, along a leader line, and the
// caption says so -- moving the marker would turn a readability fix into a
// false position.

/**
 * How much to enlarge every SYMBOL so it stays legible at the size the diagram
 * is actually being rendered at.
 *
 * The park scales with the box, which is correct -- a route's length relative to
 * the fence is the measurement. A position label does not: at 390 px wide the
 * 12-unit label rendered at 4.7 device pixels and the 7-unit fielder marker at
 * under 3, so the phone got a diagram whose marks were smaller than the pointer
 * meant to hit them. Symbols are therefore kept at roughly constant device size,
 * which is what a map legend does and what a map scale bar does not.
 *
 * NOTHING MOVES. Only radii, stroke widths and font sizes change.
 */
function useSymbolScale(ref) {
  const [scale, setScale] = useState(1)
  useEffect(() => {
    const node = ref.current
    if (!node || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect?.width
      if (!width) return
      // Solve for a roughly constant on-screen symbol: a 12-unit label lands
      // near 10 device pixels at every width this page is used at, from an
      // 816 px card down to a 330 px phone. Never below 1, so a very wide
      // screen keeps the size the diagram was designed at.
      setScale(Math.min(3.2, Math.max(1, (VIEW_WIDTH / Math.max(width, 1)) * 0.85)))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref])
  return scale
}

const POSITION_COLORS = {
  P: '#94a3b8', C: '#94a3b8', '1B': '#38bdf8', '2B': '#38bdf8',
  '3B': '#38bdf8', SS: '#38bdf8', LF: '#34d399', CF: '#34d399', RF: '#34d399',
}

/**
 * Fit the drawing to what is actually on it.
 *
 * The old scale reserved a box of `maxFenceRadius` in BOTH axes. A ballpark is
 * not that box: the deepest point straight out is shorter than the longest
 * radius, and the widest point is that radius times sin(45). So the fan was
 * being drawn into about 60% of the space it had and the play came out a third
 * smaller than it needed to be, which on a phone was the difference between
 * reading a route and not.
 *
 * This is still ONE SIMILARITY TRANSFORM -- a single scale applied to both axes
 * and a translation, nothing fitted per-axis -- so every relative position, and
 * therefore every disagreement the diagram exists to reveal, is preserved. A
 * per-axis stretch would make the play fit and make the geometry a lie.
 */
function useProjection(stadiumKey) {
  return useMemo(() => {
    const radius = parkMaxRadius(stadiumKey) || 130
    // The real outline, sampled the same way the fence path is drawn.
    const world = [{ x: HOME_PLATE.x, z: HOME_PLATE.z }]
    for (let angle = -45; angle <= 45; angle += 1) {
      const sampled = fenceRadiusAt(stadiumKey, angle)
      const useRadius = Number.isFinite(sampled) ? sampled : radius
      const radians = (angle * Math.PI) / 180
      world.push({
        x: HOME_PLATE.x + Math.sin(radians) * useRadius,
        z: HOME_PLATE.z - Math.cos(radians) * useRadius,
      })
    }
    // The catcher stands BEHIND the plate -- about 4.5 units of +z -- and the
    // fence never goes there, so a box fitted to the fence alone clipped him
    // off the bottom of every diagram. This is the backstop allowance, a fixed
    // share of the park so the frame stays identical from play to play; fitting
    // the box to the actors instead would rescale the field every time somebody
    // moved, and two plays could no longer be compared by eye.
    world.push({ x: HOME_PLATE.x, z: HOME_PLATE.z + radius * 0.07 })
    const xs = world.map((point) => point.x)
    const zs = world.map((point) => point.z)
    // A little air so a marker on the fence is not clipped in half.
    const margin = radius * 0.04
    const minX = Math.min(...xs) - margin
    const maxX = Math.max(...xs) + margin
    const minZ = Math.min(...zs) - margin
    const maxZ = Math.max(...zs) + margin
    const spanX = Math.max(maxX - minX, 1)
    const spanZ = Math.max(maxZ - minZ, 1)
    const scale = Math.min(
      (VIEW_WIDTH - PADDING * 2) / spanX,
      (VIEW_HEIGHT - PADDING * 2) / spanZ,
    )
    // Centre whatever is left over, so the park sits in the middle of the box
    // rather than pinned to one corner of it.
    const originX = (VIEW_WIDTH - spanX * scale) / 2 - minX * scale
    // -Z is centre field, so screen Y grows as Z shrinks.
    const originY = (VIEW_HEIGHT - spanZ * scale) / 2 - minZ * scale
    return {
      radius,
      scale,
      // How far the foul line runs before it meets the fence, so the dashed
      // lines stop at the wall instead of defining a box nothing reaches.
      foulRadius(angle) {
        const sampled = fenceRadiusAt(stadiumKey, angle)
        return Number.isFinite(sampled) ? sampled : radius
      },
      project(x, z) {
        return { x: originX + x * scale, y: originY + z * scale }
      },
    }
  }, [stadiumKey])
}

/**
 * Fair territory as a CLOSED shape: home plate, out along the left-field line,
 * around the measured fence, back down the right-field line.
 *
 * It used to be the fence arc alone. An unclosed path still fills, and SVG
 * closes it with a straight segment from the last point to the first -- so
 * every park was drawn with a hard line straight across the outfield between
 * the two foul poles, which reads exactly like a wall that is not there.
 */
function fencePath(stadiumKey, projection) {
  const samples = PARK_FENCES[stadiumKey]
  if (!samples?.length) return null
  const home = projection.project(HOME_PLATE.x, HOME_PLATE.z)
  const points = [home]
  for (let angle = -45; angle <= 45; angle += 1) {
    const radius = fenceRadiusAt(stadiumKey, angle)
    if (!Number.isFinite(radius)) continue
    const radians = (angle * Math.PI) / 180
    points.push(projection.project(
      HOME_PLATE.x + Math.sin(radians) * radius,
      HOME_PLATE.z - Math.cos(radians) * radius,
    ))
  }
  if (points.length < 2) return null
  return `${points.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')} Z`
}

function Badge({ label }) {
  const tone = {
    DIVE: '#fb923c', CONTACT: '#38bdf8', MISS: '#f87171', BOBBLE: '#fbbf24',
    SECURED: '#4ade80', EGG: '#a78bfa', 'BUDDY JUMP': '#f472b6',
    'BUDDY THROW': '#f472b6', 'BUDDY HANDOFF': '#f472b6', RELAY: '#60a5fa',
    WALL: '#fdba74', PROJECTED: '#7dd3fc', UNKNOWN: '#94a3b8', TRUNCATED: '#f87171',
  }[label] || '#94a3b8'
  return (
    <span style={{
      display: 'inline-block', padding: '2px 7px', borderRadius: 5,
      border: `1px solid ${tone}`, color: tone, background: `${tone}18`,
      fontSize: 10, fontWeight: 800, letterSpacing: 0.5, whiteSpace: 'nowrap',
    }}>{label}</span>
  )
}

function LegendItem({ swatch, children }) {
  return (
    <span className="tc-legend-item">
      <svg width="20" height="12" aria-hidden="true" focusable="false">{swatch}</svg>
      <span>{children}</span>
    </span>
  )
}

export default function TrackerPlayDiagram({
  stadiumKey,
  geometry,
  badges = [],
  height = 430,
  showLegend = true,
}) {
  const frameRef = useRef(null)
  const symbol = useSymbolScale(frameRef)
  const projection = useProjection(stadiumKey)
  const fence = useMemo(
    () => (hasMeasuredGeometry(stadiumKey) ? fencePath(stadiumKey, projection) : null),
    [stadiumKey, projection],
  )
  const corners = useMemo(() => infieldCorners(), [])

  const point = useMemo(() => (triple) => (Array.isArray(triple) && triple.length >= 3
    ? projection.project(triple[0], triple[2]) : null), [projection])

  // Labels are laid out before anything is drawn, because a label's slot
  // depends on every other marker's position.
  const labelled = useMemo(() => {
    if (!geometry?.fielders) return []
    const markers = geometry.fielders
      .map((fielder) => {
        const at = point(fielder.start)
        if (!at) return null
        return {
          key: fielder.position,
          x: at.x,
          y: at.y,
          text: fielder.position,
          priority: Boolean(fielder.fielded || fielder.deflected),
          fielder,
        }
      })
      .filter(Boolean)
    return placeLabels(markers, { spread: symbol })
  }, [geometry, point, symbol])

  if (!hasMeasuredGeometry(stadiumKey)) {
    return (
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        {stadiumKey
          ? `${String(stadiumKey).replace(/_/g, ' ')} has no measured fence yet, so the play cannot be
             drawn to scale. Run scripts/collect_fence_samples.py --mode press for this park.`
          : 'Pick a stadium to draw the play.'}
      </p>
    )
  }
  if (!geometry) {
    return (
      <p className="muted" style={{ margin: 0, fontSize: 12 }}>
        No 60 Hz play is attached to this at-bat, so there are no measured positions to draw.
      </p>
    )
  }

  const contactPoint = point(geometry.contact_at) || projection.project(HOME_PLATE.x, HOME_PLATE.z)
  const endpoint = point(geometry.first_touch?.at) || point(geometry.landing?.at)
  const caught = Boolean(geometry.first_touch) && !geometry.landing

  const infield = ['home', 'first', 'second', 'third'].map((name) => {
    const corner = corners[name]
    return { name, ...projection.project(corner.x, corner.z) }
  })

  const description = describePlayGeometry(geometry, stadiumKey)

  return (
    <div>
      {badges.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 8 }}>
          {badges.map((label) => <Badge key={label} label={label} />)}
        </div>
      )}
      <div ref={frameRef}>
      <svg
        className="tc-diagram"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        // A cap, not a size: the diagram grows to whatever the card gives it.
        // The cap is expressed as a WIDTH rather than a height on purpose --
        // capping the height of an SVG that is still full width letterboxes the
        // drawing inside its own box, which is how the play ended up occupying
        // 40% of a panel that was entirely available to it.
        style={{ maxWidth: height ? `${Math.round(height * (VIEW_WIDTH / VIEW_HEIGHT))}px` : undefined }}
        role="img"
        aria-labelledby="tpd-title tpd-desc"
      >
        <title id="tpd-title">Measured play diagram</title>
        <desc id="tpd-desc">{description}</desc>
        <defs>
          <marker id="tpd-arrow" viewBox="0 0 10 10" refX="9" refY="5"
            markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="#fbbf24" />
          </marker>
        </defs>

        {/* park */}
        {fence && <path d={fence} fill="rgba(52, 211, 153, 0.06)" stroke="rgba(52, 211, 153, 0.5)" strokeWidth="2" />}
        <polygon
          points={infield.map((corner) => `${corner.x.toFixed(1)},${corner.y.toFixed(1)}`).join(' ')}
          fill="rgba(148, 163, 184, 0.07)"
          stroke="rgba(148, 163, 184, 0.45)"
          strokeWidth="1.5"
        />
        {[-45, 45].map((angle) => {
          const radians = (angle * Math.PI) / 180
          const lineRadius = projection.foulRadius(angle)
          const end = projection.project(
            HOME_PLATE.x + Math.sin(radians) * lineRadius,
            HOME_PLATE.z - Math.cos(radians) * lineRadius,
          )
          const home = projection.project(HOME_PLATE.x, HOME_PLATE.z)
          return (
            <line key={angle} x1={home.x} y1={home.y} x2={end.x} y2={end.y}
              stroke="rgba(148, 163, 184, 0.35)" strokeWidth="1" strokeDasharray="6 6" />
          )
        })}

        {/* the bases themselves, from the same measured corners as the diamond.
            Without them a route that ends "at second" is a line ending in empty
            space, and a throw's target base has nothing to point at. */}
        {infield.map((corner) => (
          <g key={`base-${corner.name}`}>
            <rect
              x={corner.x - 5 * symbol} y={corner.y - 5 * symbol}
              width={10 * symbol} height={10 * symbol}
              transform={`rotate(45 ${corner.x} ${corner.y})`}
              fill="rgba(226, 232, 240, 0.85)" stroke="rgba(15, 23, 42, 0.8)" strokeWidth="1"
            />
            <title>{corner.name === 'home' ? 'home plate' : `${corner.name} base`}</title>
          </g>
        ))}

        {/* THE BALL'S PATH GOES UNDER THE ROUTES, as a wide translucent
            corridor with a thin core. Drawn on top -- which is where it was --
            it completely hid the primary fielder's route whenever the two ran
            parallel, which is most catches: the one route a reader wants was
            the one route covered up. Underneath, the corridor still shows on
            both sides of any route that follows it. */}
        {endpoint && (
          <g>
            <line x1={contactPoint.x} y1={contactPoint.y} x2={endpoint.x} y2={endpoint.y}
              stroke="#fde047" strokeWidth={9 * symbol} strokeOpacity="0.22" strokeLinecap="round" />
            <line x1={contactPoint.x} y1={contactPoint.y} x2={endpoint.x} y2={endpoint.y}
              stroke="#fde047" strokeWidth={2.5 * symbol} strokeOpacity="0.95" />
            <title>Batted ball</title>
          </g>
        )}

        {/* fielder routes: where each one started at pitch release, and where
            the play took them. Only fielders who actually moved get a line. */}
        {labelled.map(({ fielder, x, y, label, key }) => {
          const end = point(fielder.end)
          const color = POSITION_COLORS[fielder.position] || '#94a3b8'
          const moved = end && Math.hypot(end.x - x, end.y - y) > 6
          const leader = Math.hypot(label.dx, label.dy) > 24 * symbol
          return (
            <g key={key}>
              {moved && (
                <line x1={x} y1={y} x2={end.x} y2={end.y}
                  stroke={color} strokeWidth={(fielder.fielded ? 3.5 : 2) * symbol}
                  strokeOpacity={fielder.fielded ? 0.95 : 0.55} />
              )}
              <circle cx={x} cy={y} r={(fielder.fielded ? 9 : 7) * symbol}
                fill="rgba(15, 23, 42, 0.85)" stroke={color}
                strokeWidth={(fielder.fielded ? 3 : 2) * symbol} />
              {/* A displaced label gets a hairline back to its marker, so the
                  reader can always tell which circle it names. */}
              {leader && (
                <line x1={x} y1={y} x2={label.cx} y2={label.cy}
                  stroke={color} strokeWidth={symbol} strokeOpacity="0.5" strokeDasharray="3 3" />
              )}
              <text x={label.cx} y={label.cy + 4 * symbol} textAnchor="middle"
                fontSize={12 * symbol} fontWeight="800" fill={color}
                stroke="rgba(2, 6, 23, 0.85)" strokeWidth={3 * symbol} paintOrder="stroke">
                {fielder.position}
              </text>
              <title>
                {`${fielder.position}${fielder.character ? ` — ${fielder.character}` : ''}`
                  + `${fielder.path_units != null ? `\npath ${fielder.path_units.toFixed(1)}u` : ''}`
                  + `${fielder.route_efficiency != null ? `\nroute efficiency ${fielder.route_efficiency.toFixed(3)}` : ''}`
                  + `${fielder.sprint_speed_ups != null ? `\nsprint ${fielder.sprint_speed_ups.toFixed(2)} u/s` : ''}`
                  + `${fielder.assist_units ? `\nglided ${fielder.assist_units.toFixed(1)}u by the game` : ''}`
                  + `${fielder.frozen_seconds ? `\nfrozen ${fielder.frozen_seconds.toFixed(1)}s — no route or reaction measured` : ''}`}
              </title>
            </g>
          )
        })}

        {/* runner routes */}
        {geometry.runners.map((runner) => {
          const start = point(runner.start)
          const end = point(runner.end)
          if (!start || !end) return null
          if (Math.hypot(end.x - start.x, end.y - start.y) < 6) return null
          return (
            <g key={runner.slot}>
              <line x1={start.x} y1={start.y} x2={end.x} y2={end.y}
                stroke="#f472b6" strokeWidth={2.5 * symbol} strokeDasharray="7 5" strokeOpacity="0.85" />
              <circle cx={end.x} cy={end.y} r={5 * symbol} fill="#f472b6" />
              <title>
                {`${runner.slot}${runner.character ? ` — ${runner.character}` : ''}`
                  + `${runner.bases_ran != null ? `\nbases ran ${runner.bases_ran}` : ''}`
                  + `${runner.sprint_speed_ups != null ? `\nsprint ${runner.sprint_speed_ups.toFixed(2)} u/s` : ''}`}
              </title>
            </g>
          )
        })}

        {/* every fielding contact event, at the coordinates it happened */}
        {geometry.fielding_events.filter((event) => event.event_type === 'fielding_action').map((event, index) => {
          const at = point(event.at)
          if (!at) return null
          const color = event.ball_contact === 'confirmed' ? '#fbbf24'
            : event.ball_contact === 'missed' ? '#f87171' : '#94a3b8'
          return (
            <g key={`${event.frame}-${index}`}>
              <line x1={at.x - 7 * symbol} y1={at.y - 7 * symbol} x2={at.x + 7 * symbol} y2={at.y + 7 * symbol}
                stroke={color} strokeWidth={3 * symbol} />
              <line x1={at.x - 7 * symbol} y1={at.y + 7 * symbol} x2={at.x + 7 * symbol} y2={at.y - 7 * symbol}
                stroke={color} strokeWidth={3 * symbol} />
              <title>
                {`${event.character || event.by}: attempt, contact ${event.ball_contact}`
                  + `, mechanic ${event.mechanic}, action ${event.action_code}`}
              </title>
            </g>
          )
        })}

        {/* throw chain */}
        {geometry.throws.map((entry) => {
          const start = point(entry.start)
          const end = point(entry.end)
          if (!start || !end) return null
          return (
            <g key={entry.sequence}>
              <line x1={start.x} y1={start.y} x2={end.x} y2={end.y}
                stroke="#fbbf24" strokeWidth={(entry.buddy_throw ? 4 : 2.5) * symbol}
                strokeDasharray={entry.buddy_throw ? '10 4' : undefined}
                markerEnd="url(#tpd-arrow)" />
              <title>
                {`${entry.thrower_position} → ${entry.receiver_position}`
                  + `${entry.target_base ? ` at ${entry.target_base}` : ''}`
                  + `${entry.peak_speed_mph != null ? `\n${entry.peak_speed_mph.toFixed(0)} mph` : ''}`
                  + `${entry.intended_target_position && entry.intended_target_position !== entry.receiver_position
                    ? `\naimed at ${entry.intended_target_position}` : ''}`
                  + `${entry.buddy_throw ? '\nBuddy Throw — the partner released it, so this is not an arm measurement' : ''}`}
              </title>
            </g>
          )
        })}

        {/* the endpoint, last, so nothing can be drawn over the one mark that
            says whether the ball was caught or hit the ground */}
        {endpoint && (
          <g>
            <circle cx={endpoint.x} cy={endpoint.y} r={9 * symbol}
              fill={caught ? '#fde047' : 'rgba(2, 6, 23, 0.75)'} stroke="#fde047" strokeWidth={3 * symbol} />
            <title>
              {caught
                ? `Caught in flight by ${geometry.first_touch?.character || geometry.first_touch?.by || 'a fielder'}`
                : 'Landed'}
            </title>
          </g>
        )}
        <circle cx={contactPoint.x} cy={contactPoint.y} r={5 * symbol} fill="#fde047">
          <title>Contact</title>
        </circle>
      </svg>
      </div>

      {showLegend && (
        <div className="tc-legend">
          <LegendItem swatch={<circle cx="10" cy="6" r="5" fill="none" stroke="#38bdf8" strokeWidth="2" />}>
            Fielder at pitch release
          </LegendItem>
          <LegendItem swatch={<line x1="1" y1="6" x2="19" y2="6" stroke="#34d399" strokeWidth="3" />}>
            Route
          </LegendItem>
          <LegendItem swatch={<line x1="1" y1="6" x2="19" y2="6" stroke="#fde047" strokeWidth="3" />}>
            Ball flight
          </LegendItem>
          <LegendItem swatch={<circle cx="10" cy="6" r="5" fill="#fde047" stroke="#fde047" strokeWidth="2" />}>
            Caught in flight
          </LegendItem>
          <LegendItem swatch={<circle cx="10" cy="6" r="5" fill="none" stroke="#fde047" strokeWidth="2" />}>
            Landed
          </LegendItem>
          <LegendItem swatch={(
            <g stroke="#fbbf24" strokeWidth="2">
              <line x1="4" y1="1" x2="16" y2="11" /><line x1="4" y1="11" x2="16" y2="1" />
            </g>
          )}>
            Fielding contact
          </LegendItem>
          <LegendItem swatch={<line x1="1" y1="6" x2="19" y2="6" stroke="#fbbf24" strokeWidth="2" markerEnd="url(#tpd-arrow)" />}>
            Throw
          </LegendItem>
          <LegendItem swatch={<line x1="1" y1="6" x2="19" y2="6" stroke="#f472b6" strokeWidth="2" strokeDasharray="4 3" />}>
            Runner
          </LegendItem>
        </div>
      )}

      {/* A diagram with no yellow on it is not a rendering failure, and saying
          nothing left the reader hunting for a ball that was never measured. */}
      {!endpoint && (
        <p style={{ margin: '6px 0 0', fontSize: 11, color: '#fbbf24' }}>
          No measured endpoint for this ball, so no flight and no landing are drawn. The fielders,
          routes and throws below are still measured.
        </p>
      )}
      <p className="muted" style={{ margin: '6px 0 0', fontSize: 10 }}>
        Measured fence · fielders at pitch release · 1 unit = 1 m ({FEET_PER_UNIT.toFixed(3)} ft).
        Markers sit exactly where the capture put them; only a crowded LABEL is displaced, on a
        dashed leader. No dive is drawn: the capture has no signal that distinguishes one.
      </p>
    </div>
  )
}

export { Badge as TrackerPlayBadge }
export { describePlayGeometry, placeLabels }
