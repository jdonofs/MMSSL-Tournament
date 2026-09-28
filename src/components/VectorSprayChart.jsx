import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  FEET_PER_UNIT,
  HOME_PLATE,
  MEASURED_PARK_KEYS,
  PARK_FENCES,
  allParksMaxRadius,
  clampToFairTerritory,
  fenceRadiusAt,
  hasImageCalibration,
  hasMeasuredGeometry,
  infieldCorners,
  parkMaxRadius,
  standsHeightUnits,
  worldLandingToImagePercentAtHeight,
  worldToImagePercent,
  worldToImagePercentAtHeight,
  worldToPolar,
} from '../utils/parkGeometry'
import { STADIUM_CONFIGS, STADIUM_KEY_LABELS } from './FieldPlayBuilder'
import { isBarrel } from '../utils/hitDistanceStats'
import { buildAtBatPath } from '../utils/scorebookRouting'

// Drawn from measured world geometry rather than onto a stadium screenshot.
// The whole chart is one similarity transform away from the game's own
// coordinates — scale and translate, nothing fitted — so a hit lands exactly
// where the ball did. The screenshot approach needed a per-park projection
// calibrated from hand-tapped points, which put an eyeballed transform at the
// end of an otherwise exact measurement chain.
//
// The other thing this buys is TRUE SCALE across parks. Every park is rendered
// against one shared extent, so comparing two of them on one diagram actually
// means something.

const VIEWBOX = 1000
// Leave room outside the deepest fence for the marker radius and a little air.
const PADDING = 40

const DOT_COLORS = {
  HR: '#D6266E',
  IPHR: '#D6266E',
  '3B': '#F4C430',
  '2B': '#8B5CF6',
  '1B': '#F2761E',
}
const OUT_DOT_COLOR = '#94A3B8'
const ERROR_DOT_COLOR = '#06B6D4'
const ALL_PARKS_KEY = '__all__'

const LEGEND_ITEMS = [
  { label: 'Single', color: DOT_COLORS['1B'] },
  { label: 'Double', color: DOT_COLORS['2B'] },
  { label: 'Triple', color: DOT_COLORS['3B'] },
  { label: 'Home Run', color: DOT_COLORS.HR },
  { label: 'Error', color: ERROR_DOT_COLOR },
  { label: 'Out', color: OUT_DOT_COLOR },
]

const RESULT_LABELS = {
  HR: 'Home Run',
  IPHR: 'Inside-the-Park HR',
  '3B': 'Triple',
  '2B': 'Double',
  '1B': 'Single',
}

function aspectRatioValue(aspectRatio) {
  const [w, h] = String(aspectRatio || '1/1').split('/').map(Number)
  return w > 0 && h > 0 ? w / h : 1
}

function dotColorFor(pa) {
  if (pa.is_error) return ERROR_DOT_COLOR
  return DOT_COLORS[pa.result] || OUT_DOT_COLOR
}

function dotRadiusFor(pa) {
  return pa.result === 'HR' || pa.result === 'IPHR' ? 9 : 7
}

function resultLabelFor(pa) {
  if (pa.is_error) return 'Error'
  return RESULT_LABELS[pa.result] || pa.result || 'Out'
}

// World units -> SVG. Home plate sits near the bottom centre and -Z (centre
// field) runs up the screen, matching how every other baseball diagram reads.
function makeProjector(maxRadius) {
  const extent = maxRadius + PADDING / 8
  const scale = (VIEWBOX / 2) / extent
  return {
    scale,
    project(x, z) {
      return {
        x: (VIEWBOX / 2) + ((x - HOME_PLATE.x) * scale),
        // Home plate is placed near the bottom rather than at the centre: a
        // ballpark only occupies the quarter-turn of fair territory, so
        // centring it would waste most of the canvas.
        y: VIEWBOX - PADDING + ((z - HOME_PLATE.z) * scale),
      }
    },
    projectPolar(angleDeg, radiusUnits) {
      const radians = (angleDeg * Math.PI) / 180
      return this.project(
        HOME_PLATE.x + (radiusUnits * Math.sin(radians)),
        HOME_PLATE.z - (radiusUnits * Math.cos(radians)),
      )
    },
  }
}

function fencePath(parkKey, projector) {
  const fence = PARK_FENCES[parkKey]
  if (!fence?.length) return null
  const points = fence.map(([angle, radius]) => projector.projectPolar(angle, radius))
  // Close the outfield arc back down the foul lines to home, so the fair
  // territory the chart describes is the region actually enclosed.
  const home = projector.project(HOME_PLATE.x, HOME_PLATE.z)
  return [
    `M ${home.x.toFixed(1)} ${home.y.toFixed(1)}`,
    ...points.map((p) => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`),
    'Z',
  ].join(' ')
}

function InfieldMarks({ projector }) {
  const corners = infieldCorners()
  const home = projector.project(corners.home.x, corners.home.z)
  const first = projector.project(corners.first.x, corners.first.z)
  const second = projector.project(corners.second.x, corners.second.z)
  const third = projector.project(corners.third.x, corners.third.z)
  const rubber = projector.project(corners.rubber.x, corners.rubber.z)
  const diamond = [home, first, second, third]
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ')

  return (
    <g>
      <path d={`${diamond} Z`} fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.35)" strokeWidth="2" />
      <circle cx={rubber.x} cy={rubber.y} r="4" fill="rgba(255,255,255,0.45)" />
      {[home, first, second, third].map((p, i) => (
        <rect
          key={i}
          x={p.x - 4}
          y={p.y - 4}
          width="8"
          height="8"
          transform={`rotate(45 ${p.x} ${p.y})`}
          fill="rgba(255,255,255,0.7)"
        />
      ))}
    </g>
  )
}

function FoulLines({ parkKey, projector }) {
  const home = projector.project(HOME_PLATE.x, HOME_PLATE.z)
  // A foul line runs to wherever the fence actually is at 45 degrees, so the
  // lines terminate on the wall rather than at an arbitrary length.
  return [-45, 45].map((angle) => {
    const radius = fenceRadiusAt(parkKey, angle) ?? parkMaxRadius(parkKey) ?? 0
    const end = projector.projectPolar(angle, radius)
    return (
      <line
        key={angle}
        x1={home.x}
        y1={home.y}
        x2={end.x}
        y2={end.y}
        stroke="rgba(255,255,255,0.25)"
        strokeWidth="1.5"
        strokeDasharray="6 6"
      />
    )
  })
}

// Distance rings are labelled in feet, which is the one place the base-path
// assumption shows up on screen. Everything else here is measured.
function DistanceRings({ maxRadius, projector }) {
  const rings = []
  for (let feet = 100; feet / FEET_PER_UNIT <= maxRadius; feet += 100) {
    const radius = feet / FEET_PER_UNIT
    const points = []
    for (let angle = -50; angle <= 50; angle += 2) {
      const p = projector.projectPolar(angle, radius)
      points.push(`${points.length === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    }
    const label = projector.projectPolar(0, radius)
    rings.push(
      <g key={feet}>
        <path d={points.join(' ')} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="1" />
        <text x={label.x} y={label.y - 6} fill="rgba(255,255,255,0.3)" fontSize="18" textAnchor="middle">
          {feet} ft
        </text>
      </g>,
    )
  }
  return rings
}

// A plate appearance can be positioned exactly (world coordinates from the
// tracker) or approximately (older rows carrying only distance and launch
// angle). Only the first is the ball's real landing spot — launch direction is
// where a ball STARTED, and a curving one does not keep it — so approximate
// rows are drawn hollow rather than being silently passed off as measured.
// Deck height for a ball we only estimated the position of. Null unless the
// park has a measured deck profile and the estimate actually clears the wall.
function standsHeightForEstimate(pa) {
  if (!pa.hit_position_estimated || !pa.hit_stadium_key) return null
  const polar = worldToPolar(pa.hit_world_x, pa.hit_world_z)
  if (!polar) return null
  return standsHeightUnits(pa.hit_stadium_key, polar.angleDeg, polar.distanceUnits)
}

function positionFor(pa) {
  if (pa.hit_world_x != null && pa.hit_world_z != null) {
    // An extrapolated landing is an estimate, so the foul lines still apply to
    // it; a tracked one is a measurement and is left exactly where it was, foul
    // ground included.
    const raw = pa.hit_position_estimated
      ? clampToFairTerritory(pa.hit_world_x, pa.hit_world_z)
      : { x: Number(pa.hit_world_x), z: Number(pa.hit_world_z) }
    if (!raw) return null
    return {
      x: raw.x,
      z: raw.z,
      // Where the ball physically ended, including height. A home run into the
      // stands finishes well above the ground, and drawn at the ground point
      // beneath itself it reads short on the artwork.
      //
      // A tracked ball carries its own measured height. A PROJECTED one does
      // not — it has a position but no height — so a ball estimated to clear
      // the wall gets the measured height of the deck it would land on, rather
      // than being drawn as though the stands were the field.
      height: pa.hit_world_y != null
        ? Number(pa.hit_world_y)
        : (standsHeightForEstimate(pa) ?? 0),
      exact: !pa.hit_position_estimated,
    }
  }
  if (pa.hit_distance_ft != null && pa.hit_angle_deg != null) {
    const radius = Number(pa.hit_distance_ft) / FEET_PER_UNIT
    const radians = (Number(pa.hit_angle_deg) * Math.PI) / 180
    if (!Number.isFinite(radius) || !Number.isFinite(radians)) return null
    const fair = clampToFairTerritory(
      HOME_PLATE.x + (radius * Math.sin(radians)),
      HOME_PLATE.z - (radius * Math.cos(radians)),
    )
    if (!fair) return null
    return { x: fair.x, z: fair.z, height: 0, exact: false }
  }
  return null
}

// A hit scored by hand is a tap on the park artwork, and that tap is the
// record. The artwork view draws it exactly where it was tapped; the diagram,
// which has no image to tap on, places it from the distance and angle derived
// from the tap. Tracker rows carry world coordinates and never take this path.
function tappedSpotFor(pa) {
  if (pa.hit_world_x != null || pa.hit_x == null || pa.hit_y == null) return null
  const x = Number(pa.hit_x)
  const y = Number(pa.hit_y)
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null
}

function HitTooltip({ pa, position, onClose, stadiumLabel, characterName }) {
  const flipUp = position.y > VIEWBOX * 0.55
  const distance = pa.hit_distance_ft == null ? null : Number(pa.hit_distance_ft)
  const polar = worldToPolar(
    pa.hit_world_x ?? HOME_PLATE.x,
    pa.hit_world_z ?? HOME_PLATE.z,
  )
  const measuredDistance = pa.hit_world_x != null && polar
    ? Math.round(polar.distanceUnits * FEET_PER_UNIT)
    : null
  const impactHeight = Number(pa.hit_world_y)
  // Live preview supplies the flag explicitly. A newly persisted wall-impact
  // HR has no metadata column for it, but remains unambiguous: its stored carry
  // is materially beyond the horizontal radius of an elevated measured impact.
  const projectedDistance = Number.isFinite(distance) && (
    pa.hit_distance_is_projected === true
    || (
      Number.isFinite(impactHeight) && impactHeight > 1
      && measuredDistance != null && distance > measuredDistance + 3
    )
  )

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        left: `${(position.x / VIEWBOX) * 100}%`,
        top: `${(position.y / VIEWBOX) * 100}%`,
        transform: `translate(-50%, ${flipUp ? 'calc(-100% - 12px)' : '12px'})`,
        background: 'rgba(15,23,42,0.96)',
        border: '1px solid rgba(255,255,255,0.18)',
        borderRadius: 8,
        padding: '8px 10px',
        fontSize: 11,
        color: '#E2E8F0',
        whiteSpace: 'nowrap',
        zIndex: 10,
        boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
      }}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        style={{
          position: 'absolute', top: 2, right: 4, background: 'none', border: 'none',
          color: '#94A3B8', fontSize: 12, cursor: 'pointer', padding: 2, lineHeight: 1,
        }}
      >
        ×
      </button>
      <div style={{ fontWeight: 700, marginBottom: 4, paddingRight: 10 }}>{resultLabelFor(pa)}</div>
      {characterName ? <div>Character: {characterName}</div> : null}
      {stadiumLabel ? <div>Stadium: {stadiumLabel}</div> : null}
      {projectedDistance
        ? <div>Projected distance: {Math.round(distance)} ft</div>
        : measuredDistance != null
          ? <div>Distance: {measuredDistance} ft</div>
          : Number.isFinite(distance) ? <div>Distance: {distance} ft</div> : null}
      {projectedDistance && measuredDistance != null
        ? <div>Wall impact: {measuredDistance} ft from home</div>
        : null}
      {projectedDistance && Number.isFinite(impactHeight)
        ? <div>Impact height: {Math.round(impactHeight * FEET_PER_UNIT)} ft</div>
        : null}
      {pa.exit_velocity_mph != null ? <div>Exit Velo: {pa.exit_velocity_mph} mph</div> : null}
      {pa.launch_angle_deg != null ? <div>Launch Angle: {pa.launch_angle_deg}°</div> : null}
      {pa.exit_velocity_mph != null && pa.launch_angle_deg != null
        && isBarrel(pa.exit_velocity_mph, pa.launch_angle_deg)
        ? <div style={{ color: '#FDE68A', fontWeight: 700 }}>⬤ Barrel</div>
        : null}
      {pa.hit_world_x == null
        ? (
          <div style={{ color: '#94A3B8', fontStyle: 'italic' }}>
            {pa.tracker_contact_seq == null ? 'placed by hand' : 'approximate — from launch angle'}
          </div>
        )
        : null}
      {pa.id != null ? (
        <div style={{ marginTop: 4 }}>
          <Link
            to={buildAtBatPath({ id: pa.id, source: pa.season_id != null ? 'season' : 'tournament' })}
            style={{ color: '#EAB308', fontWeight: 700 }}
          >
            View at-bat →
          </Link>
        </div>
      ) : null}
    </div>
  )
}

export default function VectorSprayChart({
  plateAppearances = [],
  initialStadiumKey = null,
  height = 380,
  showCharacterName = false,
}) {
  const paByPark = useMemo(() => {
    const map = new Map()
    plateAppearances.forEach((pa) => {
      if (!pa.hit_stadium_key || !hasMeasuredGeometry(pa.hit_stadium_key)) return
      if (!positionFor(pa) && !tappedSpotFor(pa)) return
      if (!map.has(pa.hit_stadium_key)) map.set(pa.hit_stadium_key, [])
      map.get(pa.hit_stadium_key).push(pa)
    })
    return map
  }, [plateAppearances])

  const parkKeys = useMemo(
    () => [...paByPark.keys()].sort((a, b) => paByPark.get(b).length - paByPark.get(a).length),
    [paByPark],
  )

  const showAllParks = parkKeys.length > 1
  const [selectedKey, setSelectedKey] = useState(
    initialStadiumKey || (showAllParks ? ALL_PARKS_KEY : parkKeys[0]),
  )
  const [activeDotKey, setActiveDotKey] = useState(null)
  const navigate = useNavigate()

  const validKeys = showAllParks ? [ALL_PARKS_KEY, ...parkKeys] : parkKeys
  const activeKey = validKeys.includes(selectedKey) ? selectedKey : validKeys[0]
  const isAllParks = activeKey === ALL_PARKS_KEY

  const maxRadius = isAllParks ? allParksMaxRadius() : (parkMaxRadius(activeKey) || 0)
  const projector = useMemo(() => makeProjector(maxRadius), [maxRadius])

  // The park artwork is only offered for a single calibrated park. On the
  // All Parks view there is no one image to draw on, and comparing parks is
  // the whole point of that view -- which needs the true-scale diagram.
  const imageAvailable = !isAllParks
    && hasImageCalibration(activeKey)
    && Boolean(STADIUM_CONFIGS[activeKey]?.image)
  const [preferImage, setPreferImage] = useState(false)
  const showImage = imageAvailable && preferImage
  const stadiumConfig = STADIUM_CONFIGS[activeKey]

  const dots = useMemo(() => {
    const source = isAllParks
      ? parkKeys.flatMap((key) => paByPark.get(key) || [])
      : (paByPark.get(activeKey) || [])
    return source
      .map((pa, index) => {
        const world = positionFor(pa)
        const tapped = tappedSpotFor(pa)
        // On the artwork a tap is drawn solid: it sits exactly where it was
        // placed, which is the whole of what a hand-scored hit records.
        if (showImage && tapped) {
          return { pa, point: { x: (tapped.x / 100) * VIEWBOX, y: (tapped.y / 100) * VIEWBOX }, exact: true, key: pa.id ?? `i${index}` }
        }
        if (!world) return null
        // On the artwork, positions run through the park's homography — the
        // exact transform for a plane in perspective — rather than the
        // diagram's scale-and-translate. Same world coordinate either way;
        // only the surface it is drawn on changes.
        const point = showImage
          ? (() => {
              // A live tracked hit explicitly says whether its endpoint is
              // hidden behind the wall artwork. Do not derive that from HR:
              // the result arrives after the endpoint and used to make one dot
              // visibly jump from its measured wall contact into the lava.
              // Older persisted rows have no flag, so preserve their previous
              // HR behaviour as a compatibility fallback only.
              const isHomeRun = pa.result === 'HR' || pa.result === 'IPHR'
              const revealOccludedLanding = pa.hit_reveal_occluded_landing
                ?? isHomeRun
              const percent = revealOccludedLanding
                ? worldLandingToImagePercentAtHeight(
                    activeKey, world.x, world.z, world.height || 0,
                  )
                : worldToImagePercentAtHeight(
                    activeKey, world.x, world.z, world.height || 0,
                  )
              return percent ? { x: (percent.x / 100) * VIEWBOX, y: (percent.y / 100) * VIEWBOX } : null
            })()
          : projector.project(world.x, world.z)
        if (!point) return null
        return { pa, point, exact: world.exact, key: pa.id ?? `i${index}` }
      })
      .filter(Boolean)
  }, [isAllParks, parkKeys, paByPark, activeKey, projector, showImage])

  if (!validKeys.length) {
    return (
      <div className="muted" style={{ fontSize: 13, padding: '1rem 0' }}>
        No hits tracked yet in a park with measured geometry.
      </div>
    )
  }

  // Every park's outline is drawn on the All Parks view, so the differences in
  // dimension are visible rather than averaged away.
  const outlineKeys = isAllParks ? MEASURED_PARK_KEYS : [activeKey]

  return (
    <div>
      {validKeys.length > 1 ? (
        <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
          {[...(showAllParks ? [ALL_PARKS_KEY] : []), ...parkKeys].map((key) => {
            const active = key === activeKey
            const count = key === ALL_PARKS_KEY
              ? parkKeys.reduce((n, k) => n + paByPark.get(k).length, 0)
              : paByPark.get(key).length
            return (
              <button
                key={key}
                type="button"
                onClick={() => { setSelectedKey(key); setActiveDotKey(null) }}
                style={{
                  padding: '2px 10px',
                  borderRadius: 999,
                  border: '1px solid rgba(255,255,255,0.18)',
                  background: active ? 'rgba(234,179,8,0.18)' : 'rgba(255,255,255,0.04)',
                  color: active ? '#FDE68A' : '#94A3B8',
                  cursor: 'pointer',
                  fontSize: 11,
                  fontWeight: 700,
                }}
              >
                {key === ALL_PARKS_KEY
                  ? `All Parks (${count})`
                  : `${STADIUM_KEY_LABELS[key] || key.replace(/_/g, ' ')} (${count})`}
              </button>
            )
          })}
        </div>
      ) : null}

      {imageAvailable ? (
        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          {[['Diagram', false], ['Park artwork', true]].map(([label, wantsImage]) => (
            <button
              key={label}
              type="button"
              onClick={() => { setPreferImage(wantsImage); setActiveDotKey(null) }}
              style={{
                padding: '2px 10px',
                borderRadius: 999,
                border: '1px solid rgba(255,255,255,0.14)',
                background: preferImage === wantsImage ? 'rgba(96,165,250,0.18)' : 'rgba(255,255,255,0.03)',
                color: preferImage === wantsImage ? '#BFDBFE' : '#94A3B8',
                cursor: 'pointer',
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}

      <div
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: showImage
            ? Math.round(height * aspectRatioValue(stadiumConfig?.aspectRatio))
            : height,
          margin: '0 auto',
          background: showImage ? 'transparent' : '#0F172A',
          borderRadius: 18,
          overflow: 'visible',
        }}
        onClick={() => setActiveDotKey(null)}
      >
        {showImage ? (
          <img
            src={stadiumConfig.image}
            alt=""
            style={{ display: 'block', width: '100%', height: 'auto', borderRadius: 18 }}
          />
        ) : null}
        <svg
          viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
          preserveAspectRatio={showImage ? 'none' : 'xMidYMid meet'}
          style={showImage
            ? { position: 'absolute', inset: 0, width: '100%', height: '100%' }
            : { display: 'block', width: '100%', height: 'auto' }}
        >
          {!showImage ? <rect width={VIEWBOX} height={VIEWBOX} rx="36" fill="#0F172A" /> : null}
          {/* On the artwork the park draws itself — overlaying our own fence,
              diamond and rings would just double up on what is already there,
              and any small calibration error would show as a visible mismatch
              rather than as better information. */}
          {!showImage ? <DistanceRings maxRadius={maxRadius} projector={projector} /> : null}

          {!showImage && outlineKeys.map((key) => {
            const path = fencePath(key, projector)
            if (!path) return null
            const isActive = !isAllParks || key === parkKeys[0]
            return (
              <path
                key={key}
                d={path}
                fill={isActive ? 'rgba(34,197,94,0.10)' : 'none'}
                stroke={isActive ? 'rgba(134,239,172,0.75)' : 'rgba(148,163,184,0.30)'}
                strokeWidth={isActive ? 3 : 1.5}
              />
            )
          })}

          {!showImage ? <FoulLines parkKey={isAllParks ? parkKeys[0] : activeKey} projector={projector} /> : null}
          {!showImage ? <InfieldMarks projector={projector} /> : null}

          {/* A caller can mark one plate appearance as selected — the tracker
              preview uses it for the at-bat currently being viewed, so it can
              be picked out among the rest of the session. */}
          {dots.filter(({ pa }) => pa.is_selected).map(({ point, key }) => (
            <circle
              key={`sel-${key}`}
              cx={point.x}
              cy={point.y}
              r={dotRadiusFor({}) + 7}
              fill="none"
              stroke="#FDE68A"
              strokeWidth="2.5"
            />
          ))}

          {dots.map(({ pa, point, exact, key }) => (
            <circle
              key={key}
              cx={point.x}
              cy={point.y}
              r={dotRadiusFor(pa)}
              fill={exact ? dotColorFor(pa) : 'none'}
              stroke={exact ? 'rgba(15,23,42,0.75)' : dotColorFor(pa)}
              strokeWidth={exact ? 1.5 : 2}
              style={{ cursor: 'pointer' }}
              onClick={(e) => {
                e.stopPropagation()
                if (pa.id != null) {
                  navigate(buildAtBatPath({ id: pa.id, source: pa.season_id != null ? 'season' : 'tournament' }))
                  return
                }
                setActiveDotKey((prev) => (prev === key ? null : key))
              }}
              onMouseEnter={() => setActiveDotKey(key)}
              onMouseLeave={() => setActiveDotKey((prev) => (prev === key ? null : prev))}
            />
          ))}
        </svg>

        {activeDotKey != null ? (() => {
          const hit = dots.find((d) => d.key === activeDotKey)
          if (!hit) return null
          return (
            <HitTooltip
              pa={hit.pa}
              position={hit.point}
              onClose={() => setActiveDotKey(null)}
              stadiumLabel={isAllParks
                ? (STADIUM_KEY_LABELS[hit.pa.hit_stadium_key] || hit.pa.hit_stadium_key?.replace(/_/g, ' '))
                : null}
              characterName={showCharacterName ? hit.pa.character_name : null}
            />
          )
        })() : null}
      </div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
        {LEGEND_ITEMS.map((item) => (
          <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{
              width: 9, height: 9, borderRadius: '50%', background: item.color,
              border: '1px solid rgba(15,23,42,0.6)', display: 'inline-block',
            }} />
            <span style={{ fontSize: 11, color: '#94A3B8' }}>{item.label}</span>
          </div>
        ))}
        {dots.some((d) => !d.exact) ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{
              width: 9, height: 9, borderRadius: '50%', background: 'none',
              border: '2px solid #94A3B8', display: 'inline-block',
            }} />
            <span style={{ fontSize: 11, color: '#94A3B8' }}>placed by hand or estimated</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
