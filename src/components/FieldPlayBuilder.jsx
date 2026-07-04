import { useRef } from 'react'
import CharacterPortrait from './CharacterPortrait'
import { POSITION_GROUP_COLORS } from './RosterLineupWidgets'

export const FIELD_POSITIONS = [
  { position: 8, label: 'CF', left: '50%', top: '27%', group: 'outfield' },
  { position: 7, label: 'LF', left: '22%', top: '38%', group: 'outfield' },
  { position: 9, label: 'RF', left: '78%', top: '38%', group: 'outfield' },
  { position: 6, label: 'SS', left: '38%', top: '48%', group: 'infield' },
  { position: 4, label: '2B', left: '62%', top: '48%', group: 'infield' },
  { position: 5, label: '3B', left: '34%', top: '64%', group: 'infield' },
  { position: 1, label: 'P',  left: '50%', top: '68%', group: 'battery' },
  { position: 3, label: '1B', left: '66%', top: '64%', group: 'infield' },
  { position: 2, label: 'C',  left: '50%', top: '85%', group: 'battery' },
]

// When a play is scored without tapping a landing spot (routine plays are
// often recorded via fielder taps alone), the fielder who first touched the
// ball stands in for "where it landed" — looked up from the same
// stadium-specific position markers rendered on the field UI, so distance/
// spray data still gets recorded for these plays.
export function getFielderFieldSpot(position, config) {
  if (position == null) return null
  const list = config?.positions ?? FIELD_POSITIONS
  const entry = list.find((p) => String(p.position) === String(position))
  if (!entry) return null
  const x = parseFloat(entry.left)
  const y = parseFloat(entry.top)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

// Estimate hit distance in feet given a landing spot (image %) and stadium config.
// Uses angular interpolation between 3 known wall reference points (LF pole, CF wall, RF pole).
export function estimateHitDistance(spot, config) {
  if (!config?.homePlate || !config?.wallRefs || !spot) return null
  const home = config.homePlate
  const dx = spot.x - home.x
  const dy = spot.y - home.y
  const hitImgDist = Math.sqrt(dx * dx + dy * dy)
  if (hitImgDist < 1) return null
  const hitAngle = Math.atan2(dx, -dy)
  const refs = config.wallRefs.map(ref => {
    const rdx = ref.x - home.x
    const rdy = ref.y - home.y
    const angle = Math.atan2(rdx, -rdy)
    const imgDist = Math.sqrt(rdx * rdx + rdy * rdy)
    return { angle, scale: imgDist / ref.dist }
  }).sort((a, b) => a.angle - b.angle)
  let scale
  if (hitAngle <= refs[0].angle) {
    scale = refs[0].scale
  } else if (hitAngle >= refs[refs.length - 1].angle) {
    scale = refs[refs.length - 1].scale
  } else {
    for (let i = 0; i < refs.length - 1; i++) {
      if (hitAngle >= refs[i].angle && hitAngle <= refs[i + 1].angle) {
        const t = (hitAngle - refs[i].angle) / (refs[i + 1].angle - refs[i].angle)
        scale = refs[i].scale * (1 - t) + refs[i + 1].scale * t
        break
      }
    }
  }
  return scale ? Math.round(hitImgDist / scale) : null
}

// Estimate hit angle in degrees off straightaway center field, given a landing
// spot (image %) and stadium config. 0deg = straightaway CF, negative = LF
// side, positive = RF side (matches the LF/CF/RF split used elsewhere).
export function estimateHitAngle(spot, config) {
  if (!config?.homePlate || !spot) return null
  const home = config.homePlate
  const dx = spot.x - home.x
  const dy = spot.y - home.y
  if (Math.sqrt(dx * dx + dy * dy) < 1) return null
  const hitAngle = Math.atan2(dx, -dy)
  return Math.round((hitAngle * 180 / Math.PI) * 10) / 10
}

// Inverse of estimateHitDistance/estimateHitAngle: given a real distance (ft)
// and angle (deg, 0 = straightaway CF), projects back onto a field image's
// x/y (%) using the same angular interpolation between wallRefs. Used to plot
// a hit on a stadium/field image other than the one it was actually tapped
// on (e.g. the normalized cross-stadium spray chart).
export function projectDistanceAngleToSpot(distanceFt, angleDeg, config) {
  if (!config?.homePlate || !config?.wallRefs || distanceFt == null || angleDeg == null) return null
  const home = config.homePlate
  const refs = config.wallRefs.map(ref => {
    const rdx = ref.x - home.x
    const rdy = ref.y - home.y
    const angle = (Math.atan2(rdx, -rdy) * 180) / Math.PI
    const imgDist = Math.sqrt(rdx * rdx + rdy * rdy)
    return { angle, scale: imgDist / ref.dist }
  }).sort((a, b) => a.angle - b.angle)

  let scale
  if (angleDeg <= refs[0].angle) {
    scale = refs[0].scale
  } else if (angleDeg >= refs[refs.length - 1].angle) {
    scale = refs[refs.length - 1].scale
  } else {
    for (let i = 0; i < refs.length - 1; i++) {
      if (angleDeg >= refs[i].angle && angleDeg <= refs[i + 1].angle) {
        const t = (angleDeg - refs[i].angle) / (refs[i + 1].angle - refs[i].angle)
        scale = refs[i].scale * (1 - t) + refs[i + 1].scale * t
        break
      }
    }
  }
  if (!scale) return null
  const imgDist = distanceFt * scale
  const angleRad = (angleDeg * Math.PI) / 180
  return {
    x: Math.round((home.x + (imgDist * Math.sin(angleRad))) * 10) / 10,
    y: Math.round((home.y - (imgDist * Math.cos(angleRad))) * 10) / 10,
  }
}

// Real wall distance (ft) at a given angle off straightaway CF, interpolated
// between a stadium's wallRefs the same way estimateHitDistance interpolates
// its image-to-feet scale — used to tell whether a caught ball (a Buddy Jump,
// most commonly) was close enough to the fence to count as a robbed home run.
export function estimateWallDistanceAtAngle(angleDeg, config) {
  if (!config?.homePlate || !config?.wallRefs || angleDeg == null) return null
  const home = config.homePlate
  const refs = config.wallRefs.map((ref) => {
    const rdx = ref.x - home.x
    const rdy = ref.y - home.y
    const angle = (Math.atan2(rdx, -rdy) * 180) / Math.PI
    return { angle, dist: ref.dist }
  }).sort((a, b) => a.angle - b.angle)
  if (angleDeg <= refs[0].angle) return refs[0].dist
  if (angleDeg >= refs[refs.length - 1].angle) return refs[refs.length - 1].dist
  for (let i = 0; i < refs.length - 1; i++) {
    if (angleDeg >= refs[i].angle && angleDeg <= refs[i + 1].angle) {
      const t = (angleDeg - refs[i].angle) / (refs[i + 1].angle - refs[i].angle)
      return refs[i].dist * (1 - t) + refs[i + 1].dist * t
    }
  }
  return null
}

// A stadium-agnostic outline field (public/stadiums/spray chart.png,
// currently 978x989) for comparing hits across every park on one diagram, in
// the style of Baseball Savant's spray charts. wallRefs use the average
// LF/CF/RF wall distance across all calibrated stadiums; homePlate/wallRefs
// x/y and the fallback fielder positions were measured directly from the
// image's geometry and converted to percentages. Points at the source file
// directly (not a copy) so re-exporting the artwork over it takes effect
// immediately — recalibrate with calibrate.html if its geometry changes.
export const GENERIC_FIELD_CONFIG = {
  image: '/stadiums/spray chart.png',
  aspectRatio: '978/989',
  homePlate: { x: 50.2, y: 91.7 },
  wallRefs: [
    { x: 10.0, y: 54.7, dist: 272 },  // LF (avg of all stadiums)
    { x: 51.2, y: 26.6, dist: 334 },  // CF (avg of all stadiums)
    { x: 90.1, y: 54.6, dist: 272 },  // RF (avg of all stadiums)
  ],
  positions: [
    { position: 8, label: 'CF', left: '50.6%', top: '33.2%', group: 'outfield' },
    { position: 7, label: 'LF', left: '23.1%', top: '46.7%', group: 'outfield' },
    { position: 9, label: 'RF', left: '77.9%', top: '47.3%', group: 'outfield' },
    { position: 6, label: 'SS', left: '40.1%', top: '47.7%', group: 'infield' },
    { position: 4, label: '2B', left: '62.1%', top: '47.9%', group: 'infield' },
    { position: 5, label: '3B', left: '24.9%', top: '63.4%', group: 'infield' },
    { position: 1, label: 'P',  left: '50.4%', top: '67.7%', group: 'battery' },
    { position: 3, label: '1B', left: '76.1%', top: '64.2%', group: 'infield' },
    { position: 2, label: 'C',  left: '50.1%', top: '94.6%', group: 'battery' },
  ],
}

export const STADIUM_KEY_LABELS = {
  mario_stadium: 'Mario Stadium',
  yoshi_park: 'Yoshi Park',
  wario_city: 'Wario City',
  daisy_cruiser: 'Daisy Cruiser',
  peach_ice_garden: 'Peach Ice Garden',
  dk_jungle: 'DK Jungle',
  bowser_jr_playroom: "Bowser Jr. Playroom",
  bowser_castle: 'Bowser Castle',
  luigis_mansion: "Luigi's Mansion",
}

export const STADIUM_CONFIGS = {
  'mario_stadium': {
    image: '/stadiums/mario-stadium.png',
    aspectRatio: '1506/1006',
    homePlate: { x: 50.0, y: 92.9 },
    wallRefs: [
      { x: 18.0, y: 44.2, dist: 259 },  // LF foul pole
      { x: 50.6, y: 21.7, dist: 317 },  // CF wall
      { x: 82.8, y: 44.6, dist: 259 },  // RF foul pole
    ],
    positions: [
      { position: 8, label: 'CF', left: '50.4%', top: '34.4%', group: 'outfield' },
      { position: 7, label: 'LF', left: '31.6%', top: '43.9%', group: 'outfield' },
      { position: 9, label: 'RF', left: '69.2%', top: '44.1%', group: 'outfield' },
      { position: 6, label: 'SS', left: '43.4%', top: '60.0%', group: 'infield' },
      { position: 4, label: '2B', left: '56.9%', top: '60.7%', group: 'infield' },
      { position: 5, label: '3B', left: '37.9%', top: '69.8%', group: 'infield' },
      { position: 1, label: 'P',  left: '50.3%', top: '75.2%', group: 'battery' },
      { position: 3, label: '1B', left: '62.6%', top: '70.2%', group: 'infield' },
      { position: 2, label: 'C',  left: '50.0%', top: '96.6%', group: 'battery' },
    ],
  },
  'yoshi_park': {
    image: '/stadiums/yoshi-park.png',
    aspectRatio: '1280/823',
    homePlate: { x: 50.2, y: 94.2 },
    wallRefs: [
      { x: 10.4, y: 49.0, dist: 253 },  // LF foul pole
      { x: 50.3, y: 25.2, dist: 324 },  // CF wall
      { x: 89.4, y: 48.7, dist: 254 },  // RF foul pole
    ],
    positions: [
      { position: 8, label: 'CF', left: '49.9%', top: '39.8%', group: 'outfield' },
      { position: 7, label: 'LF', left: '26.4%', top: '49.2%', group: 'outfield' },
      { position: 9, label: 'RF', left: '73.6%', top: '49.2%', group: 'outfield' },
      { position: 6, label: 'SS', left: '41.8%', top: '64.7%', group: 'infield' },
      { position: 4, label: '2B', left: '58.2%', top: '64.9%', group: 'infield' },
      { position: 5, label: '3B', left: '34.8%', top: '74.8%', group: 'infield' },
      { position: 1, label: 'P',  left: '50.2%', top: '78.5%', group: 'battery' },
      { position: 3, label: '1B', left: '65.4%', top: '74.6%', group: 'infield' },
      { position: 2, label: 'C',  left: '50.3%', top: '96.7%', group: 'battery' },
    ],
  },
  'wario_city': {
    image: '/stadiums/wario-stadium.png',
    aspectRatio: '1410/975',
    homePlate: { x: 50.1, y: 94.1 },
    wallRefs: [
      { x: 15.8, y: 41.8, dist: 292 },  // LF foul pole
      { x: 51.4, y: 28.3, dist: 297 },  // CF wall
      { x: 86.9, y: 43.2, dist: 289 },  // RF foul pole
    ],
    positions: [
      { position: 8, label: 'CF', left: '51.2%', top: '36.4%', group: 'outfield' },
      { position: 7, label: 'LF', left: '31.9%', top: '45.6%', group: 'outfield' },
      { position: 9, label: 'RF', left: '70.2%', top: '46.5%', group: 'outfield' },
      { position: 6, label: 'SS', left: '43.9%', top: '62.6%', group: 'infield' },
      { position: 4, label: '2B', left: '57.4%', top: '62.6%', group: 'infield' },
      { position: 5, label: '3B', left: '37.2%', top: '71.0%', group: 'infield' },
      { position: 1, label: 'P',  left: '50.6%', top: '76.7%', group: 'battery' },
      { position: 3, label: '1B', left: '64.8%', top: '71.4%', group: 'infield' },
      { position: 2, label: 'C',  left: '50.0%', top: '97.0%', group: 'battery' },
    ],
  },
  'dk_jungle': {
    image: '/stadiums/dk-jungle.png',
    aspectRatio: '1475/990',
    homePlate: { x: 50.2, y: 92.6 },
    wallRefs: [
      { x: 15.4, y: 40.8, dist: 274 },  // LF foul pole
      { x: 50.1, y: 19.2, dist: 323 },  // CF wall
      { x: 83.9, y: 39.4, dist: 275 },  // RF foul pole
    ],
    positions: [
      { position: 8, label: 'CF', left: '49.9%', top: '34.0%', group: 'outfield' },
      { position: 7, label: 'LF', left: '30.6%', top: '43.3%', group: 'outfield' },
      { position: 9, label: 'RF', left: '69.1%', top: '42.7%', group: 'outfield' },
      { position: 6, label: 'SS', left: '43.2%', top: '60.0%', group: 'infield' },
      { position: 4, label: '2B', left: '56.9%', top: '60.1%', group: 'infield' },
      { position: 5, label: '3B', left: '37.3%', top: '69.6%', group: 'infield' },
      { position: 1, label: 'P',  left: '50.2%', top: '75.0%', group: 'battery' },
      { position: 3, label: '1B', left: '63.4%', top: '69.5%', group: 'infield' },
      { position: 2, label: 'C',  left: '50.1%', top: '96.1%', group: 'battery' },
    ],
  },
  'bowser_castle': {
    image: '/stadiums/bowser-castle.png',
    aspectRatio: '1322/990',
    homePlate: { x: 49.6, y: 92.8 },
    wallRefs: [
      { x: 13.8, y: 44.7, dist: 278 },  // LF foul pole
      { x: 49.2, y: 24.2, dist: 334 },  // CF wall
      { x: 84.4, y: 43.8, dist: 277 },  // RF foul pole
    ],
    positions: [
      { position: 8, label: 'CF', left: '49.2%', top: '38.4%', group: 'outfield' },
      { position: 7, label: 'LF', left: '29.6%', top: '47.4%', group: 'outfield' },
      { position: 9, label: 'RF', left: '68.8%', top: '47.5%', group: 'outfield' },
      { position: 6, label: 'SS', left: '42.4%', top: '63.4%', group: 'infield' },
      { position: 4, label: '2B', left: '56.3%', top: '62.5%', group: 'infield' },
      { position: 5, label: '3B', left: '36.6%', top: '73.0%', group: 'infield' },
      { position: 1, label: 'P',  left: '49.7%', top: '76.9%', group: 'battery' },
      { position: 3, label: '1B', left: '61.9%', top: '72.8%', group: 'infield' },
      { position: 2, label: 'C',  left: '49.6%', top: '95.7%', group: 'battery' },
    ],
  },
  'bowser_jr_playroom': {
    image: '/stadiums/bowser-jr-playroom.png',
    aspectRatio: '1280/992',
    homePlate: { x: 49.8, y: 92.6 },
    wallRefs: [
      { x: 13.3, y: 44.2, dist: 262 },  // LF foul pole
      { x: 50.3, y: 20.8, dist: 328 },  // CF wall
      { x: 86.0, y: 44.3, dist: 264 },  // RF foul pole
    ],
    positions: [
      { position: 8, label: 'CF', left: '50.4%', top: '37.6%', group: 'outfield' },
      { position: 7, label: 'LF', left: '29.6%', top: '46.3%', group: 'outfield' },
      { position: 9, label: 'RF', left: '70.6%', top: '46.8%', group: 'outfield' },
      { position: 6, label: 'SS', left: '42.7%', top: '62.4%', group: 'infield' },
      { position: 4, label: '2B', left: '57.3%', top: '62.5%', group: 'infield' },
      { position: 5, label: '3B', left: '36.2%', top: '71.9%', group: 'infield' },
      { position: 1, label: 'P',  left: '50.1%', top: '76.1%', group: 'battery' },
      { position: 3, label: '1B', left: '63.0%', top: '72.1%', group: 'infield' },
      { position: 2, label: 'C',  left: '49.8%', top: '95.5%', group: 'battery' },
    ],
  },
  'daisy_cruiser': {
    image: '/stadiums/daisy-cruiser.png',
    aspectRatio: '1218/945',
    homePlate: { x: 50.3, y: 93.9 },
    wallRefs: [
      { x: 24.7, y: 62.5, dist: 232 },  // LF foul pole
      { x: 50.3, y: 37.9, dist: 328 },  // CF wall
      { x: 75.3, y: 61.7, dist: 231 },  // RF foul pole
    ],
    positions: [
      { position: 8, label: 'CF', left: '50.2%', top: '49.0%', group: 'outfield' },
      { position: 7, label: 'LF', left: '33.6%', top: '56.6%', group: 'outfield' },
      { position: 9, label: 'RF', left: '66.7%', top: '56.7%', group: 'outfield' },
      { position: 6, label: 'SS', left: '44.4%', top: '70.0%', group: 'infield' },
      { position: 4, label: '2B', left: '56.1%', top: '70.2%', group: 'infield' },
      { position: 5, label: '3B', left: '39.4%', top: '77.3%', group: 'infield' },
      { position: 1, label: 'P',  left: '50.1%', top: '80.9%', group: 'battery' },
      { position: 3, label: '1B', left: '60.8%', top: '77.9%', group: 'infield' },
      { position: 2, label: 'C',  left: '50.2%', top: '96.4%', group: 'battery' },
    ],
  },
  'peach_ice_garden': {
    image: '/stadiums/peach-ice-garden.png',
    aspectRatio: '1304/915',
    homePlate: { x: 50.0, y: 93.0 },
    wallRefs: [
      { x: 13.3, y: 41.6, dist: 314 },  // LF foul pole
      { x: 50.9, y: 18.0, dist: 402 },  // CF wall
      { x: 86.6, y: 42.9, dist: 313 },  // RF foul pole
    ],
    positions: [
      { position: 8, label: 'CF', left: '50.2%', top: '39.4%', group: 'outfield' },
      { position: 7, label: 'LF', left: '31.6%', top: '48.3%', group: 'outfield' },
      { position: 9, label: 'RF', left: '68.8%', top: '48.5%', group: 'outfield' },
      { position: 6, label: 'SS', left: '43.7%', top: '64.7%', group: 'infield' },
      { position: 4, label: '2B', left: '56.8%', top: '63.8%', group: 'infield' },
      { position: 5, label: '3B', left: '38.4%', top: '72.3%', group: 'infield' },
      { position: 1, label: 'P',  left: '50.5%', top: '77.5%', group: 'battery' },
      { position: 3, label: '1B', left: '62.2%', top: '73.8%', group: 'infield' },
      { position: 2, label: 'C',  left: '50.0%', top: '96.2%', group: 'battery' },
    ],
  },
  'luigis_mansion': {
    image: "/stadiums/luigi's-mansion.png",
    aspectRatio: '1139/988',
    homePlate: { x: 49.9, y: 90.4 },
    wallRefs: [
      { x: 13.6, y: 47.8, dist: 282 },  // LF foul pole
      { x: 49.7, y: 27.4, dist: 351 },  // CF wall
      { x: 85.8, y: 48.9, dist: 287 },  // RF foul pole
    ],
    positions: [
      { position: 8, label: 'CF', left: '49.8%', top: '42.6%', group: 'outfield' },
      { position: 7, label: 'LF', left: '29.4%', top: '51.1%', group: 'outfield' },
      { position: 9, label: 'RF', left: '69.4%', top: '50.4%', group: 'outfield' },
      { position: 6, label: 'SS', left: '42.9%', top: '64.7%', group: 'infield' },
      { position: 4, label: '2B', left: '57.0%', top: '65.1%', group: 'infield' },
      { position: 5, label: '3B', left: '36.0%', top: '71.9%', group: 'infield' },
      { position: 1, label: 'P',  left: '49.9%', top: '76.8%', group: 'battery' },
      { position: 3, label: '1B', left: '63.4%', top: '71.4%', group: 'infield' },
      { position: 2, label: 'C',  left: '49.9%', top: '92.9%', group: 'battery' },
    ],
  },
}

// Tap the field once to drop a landing-spot marker, then tap fielders in the
// order they touched the ball. Tapping a selected fielder again removes them —
// this lets a single diagram capture "where it landed" + "who's credited" + the
// play sequence (e.g. 6-3) without separate screens.
export default function FieldPlayBuilder({
  fieldersByPosition = {},
  fielderChain = [],
  landingSpot = null,
  onFieldTap,
  onToggleFielder,
  notation = '',
  accent = '#EAB308',
  label = 'Build The Play',
  allowedPositions = null,
  allowFielderSelection = true,
  stadiumKey = null,
}) {
  const containerRef = useRef(null)
  const allowedSet = allowedPositions ? new Set(allowedPositions.map((position) => String(position))) : null
  const stadiumConfig = stadiumKey ? STADIUM_CONFIGS[stadiumKey] : null
  const activePositions = stadiumConfig?.positions ?? FIELD_POSITIONS
  const fieldImage = stadiumConfig?.image ?? '/baseball-field.jpg'
  const fieldAspectRatio = stadiumConfig?.aspectRatio ?? '1/1.02'

  const handleFieldClick = (event) => {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const x = Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100))
    const y = Math.min(100, Math.max(0, ((event.clientY - rect.top) / rect.height) * 100))
    onFieldTap?.({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 })
  }

  return (
    <div>
      {(label || notation) ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 8 }}>
          {label ? <div style={{ fontSize: 12, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase' }}>{label}</div> : <span />}
          {notation ? (
            <div style={{ fontSize: 16, fontWeight: 800, color: accent, letterSpacing: '.04em' }}>{notation}</div>
          ) : null}
        </div>
      ) : null}
      <div
        ref={containerRef}
        onClick={handleFieldClick}
        role="button"
        tabIndex={0}
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: stadiumConfig ? 480 : 320,
          margin: '0 auto',
          border: stadiumConfig ? 'none' : '1.5px solid rgba(148,163,184,0.35)',
          borderRadius: 18,
          cursor: 'crosshair',
          overflow: 'visible',
        }}
      >
        <img src={fieldImage} alt="Baseball field" style={{ display: 'block', width: '100%', height: 'auto', pointerEvents: 'none', borderRadius: 18 }} />
        {landingSpot ? (() => {
          const dist = estimateHitDistance(landingSpot, stadiumConfig)
          return (
            <>
              <div
                style={{
                  position: 'absolute',
                  left: `${landingSpot.x}%`,
                  top: `${landingSpot.y}%`,
                  width: 14,
                  height: 14,
                  borderRadius: '50%',
                  background: `${accent}33`,
                  border: `2px solid ${accent}`,
                  transform: 'translate(-50%, -50%)',
                  pointerEvents: 'none',
                  boxShadow: `0 0 0 3px ${accent}1A`,
                }}
              />
              {dist != null ? (
                <div
                  style={{
                    position: 'absolute',
                    left: `${landingSpot.x}%`,
                    top: `${landingSpot.y}%`,
                    transform: 'translate(10px, -50%)',
                    pointerEvents: 'none',
                    fontSize: 11,
                    fontWeight: 800,
                    color: accent,
                    textShadow: '0 1px 3px rgba(0,0,0,0.8)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {dist} ft
                </div>
              ) : null}
            </>
          )
        })() : null}
        {activePositions.map((slot) => {
          const fielder = fieldersByPosition[String(slot.position)] || null
          const chainIndex = fielderChain.indexOf(String(slot.position))
          const selected = chainIndex !== -1
          const disabled = !allowFielderSelection || (allowedSet ? !allowedSet.has(String(slot.position)) : false)
          const portraitSize = stadiumConfig ? 22 : 26
          const badgeSize = stadiumConfig ? 12 : 14
          return (
            <button
              key={slot.position}
              type="button"
              disabled={disabled}
              onClick={(event) => {
                event.stopPropagation()
                if (disabled) return
                onToggleFielder?.(String(slot.position))
              }}
              style={{
                position: 'absolute',
                left: slot.left,
                top: slot.top,
                transform: 'translate(-50%, -50%)',
                width: portraitSize,
                height: portraitSize,
                borderRadius: '50%',
                border: 'none',
                background: 'transparent',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.4 : 1,
                padding: 0,
              }}
            >
              <div
                style={{
                  position: 'relative',
                  width: portraitSize,
                  height: portraitSize,
                  borderRadius: '50%',
                  boxShadow: `0 4px 10px #00000040, 0 0 0 2px ${selected ? accent : POSITION_GROUP_COLORS[slot.group]}`,
                  background: '#0F172A',
                }}
              >
                <CharacterPortrait name={fielder?.character} size={portraitSize} />
                {selected ? (
                  <span
                    style={{
                      position: 'absolute',
                      top: -4,
                      right: -4,
                      minWidth: badgeSize,
                      height: badgeSize,
                      padding: '0 2px',
                      borderRadius: 999,
                      background: accent,
                      color: '#0F172A',
                      border: '1px solid rgba(15,23,42,0.4)',
                      fontSize: stadiumConfig ? 7 : 9,
                      fontWeight: 800,
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {chainIndex + 1}
                  </span>
                ) : null}
              </div>
              <div style={{ fontSize: stadiumConfig ? 6 : 7.5, fontWeight: 800, color: selected ? accent : disabled ? '#475569' : '#F8FAFC', marginTop: 1, textShadow: '0 1px 2px rgba(0,0,0,0.7)' }}>
                {slot.label}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
