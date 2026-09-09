import { useEffect, useRef, useState } from 'react'
import CharacterPortrait from './CharacterPortrait'
import { POSITION_GROUP_COLORS } from './RosterLineupWidgets'
import { STADIUM_FIELD_GEOMETRY } from '../utils/stadiumFieldGeometry'

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
// currently 1254x1254) for comparing hits across every park on one diagram, in
// the style of Baseball Savant's spray charts. wallRefs use the average
// LF/CF/RF wall distance across all calibrated stadiums; homePlate/wallRefs
// x/y and the fallback fielder positions were measured directly from the
// image's geometry and converted to percentages. Points at the source file
// directly (not a copy) so re-exporting the artwork over it takes effect
// immediately — recalibrate with calibrate.html if its geometry changes.
export const GENERIC_FIELD_CONFIG = {
  image: '/stadiums/spray chart.png',
  aspectRatio: '1254/1254',
  homePlate: STADIUM_FIELD_GEOMETRY.generic_field.homePlate,
  wallRefs: STADIUM_FIELD_GEOMETRY.generic_field.wallRefs,
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
  generic_field: 'Generic Field',
}

export const STADIUM_CONFIGS = {
  'mario_stadium': {
    image: '/stadiums/mario-stadium.png',
    aspectRatio: '1506/1006',
    homePlate: STADIUM_FIELD_GEOMETRY.mario_stadium.homePlate,
    wallRefs: STADIUM_FIELD_GEOMETRY.mario_stadium.wallRefs,
    positions: [
      { position: 8, label: 'CF', left: '50.4%', top: '34.5%', group: 'outfield' },
      { position: 7, label: 'LF', left: '31.6%', top: '43.9%', group: 'outfield' },
      { position: 9, label: 'RF', left: '69.2%', top: '44.1%', group: 'outfield' },
      { position: 6, label: 'SS', left: '42.9%', top: '54.2%', group: 'infield' },
      { position: 4, label: '2B', left: '59.1%', top: '54.5%', group: 'infield' },
      { position: 5, label: '3B', left: '38.1%', top: '70.6%', group: 'infield' },
      { position: 1, label: 'P',  left: '50.3%', top: '74.9%', group: 'battery' },
      { position: 3, label: '1B', left: '62.2%', top: '71.4%', group: 'infield' },
      { position: 2, label: 'C',  left: '49.9%', top: '97%', group: 'battery' },
    ],
  },
  'yoshi_park': {
    image: '/stadiums/yoshi-park.png',
    aspectRatio: '1260/899',
    homePlate: STADIUM_FIELD_GEOMETRY.yoshi_park.homePlate,
    wallRefs: STADIUM_FIELD_GEOMETRY.yoshi_park.wallRefs,
    // Anchored on WORLD positions, not on the picture: through each artwork
    // swap these were carried by inverting the old PARK_IMAGE_HOMOGRAPHY and
    // re-projecting through the new one, so the markers keep the same physical
    // spots. They read 226/250/227 ft at LF/CF/RF, 125/124 at SS/2B, 99 at the
    // corners and 59.3 at P against a true rubber distance of 58.99 ft.
    positions: [
      { position: 8, label: 'CF', left: '50.3%', top: '36.1%', group: 'outfield' },
      { position: 7, label: 'LF', left: '29.9%', top: '45.7%', group: 'outfield' },
      { position: 9, label: 'RF', left: '70.8%', top: '45.9%', group: 'outfield' },
      { position: 6, label: 'SS', left: '43.0%', top: '61.9%', group: 'infield' },
      { position: 4, label: '2B', left: '57.2%', top: '62.2%', group: 'infield' },
      { position: 5, label: '3B', left: '36.6%', top: '72.5%', group: 'infield' },
      { position: 1, label: 'P',  left: '50.1%', top: '76.7%', group: 'battery' },
      { position: 3, label: '1B', left: '63.5%', top: '72.6%', group: 'infield' },
      { position: 2, label: 'C',  left: '49.9%', top: '96.5%', group: 'battery' },
    ],
  },
  'wario_city': {
    image: '/stadiums/wario-stadium.png',
    aspectRatio: '1096/978',
    homePlate: STADIUM_FIELD_GEOMETRY.wario_city.homePlate,
    wallRefs: STADIUM_FIELD_GEOMETRY.wario_city.wallRefs,
    positions: [
      { position: 8, label: 'CF', left: '51.4%', top: '36.7%', group: 'outfield' },
      { position: 7, label: 'LF', left: '31.8%', top: '45.5%', group: 'outfield' },
      { position: 9, label: 'RF', left: '70.6%', top: '46.3%', group: 'outfield' },
      { position: 6, label: 'SS', left: '41.6%', top: '55.7%', group: 'infield' },
      { position: 4, label: '2B', left: '58.5%', top: '55.7%', group: 'infield' },
      { position: 5, label: '3B', left: '37%', top: '70.8%', group: 'infield' },
      { position: 1, label: 'P',  left: '50.4%', top: '76.4%', group: 'battery' },
      { position: 3, label: '1B', left: '64.3%', top: '69.8%', group: 'infield' },
      { position: 2, label: 'C',  left: '50%', top: '97.2%', group: 'battery' },
    ],
  },
  'dk_jungle': {
    image: '/stadiums/dk-jungle.png',
    aspectRatio: '1475/990',
    homePlate: STADIUM_FIELD_GEOMETRY.dk_jungle.homePlate,
    wallRefs: STADIUM_FIELD_GEOMETRY.dk_jungle.wallRefs,
    positions: [
      { position: 8, label: 'CF', left: '49.9%', top: '33.9%', group: 'outfield' },
      { position: 7, label: 'LF', left: '30.5%', top: '43.3%', group: 'outfield' },
      { position: 9, label: 'RF', left: '69.1%', top: '42.8%', group: 'outfield' },
      { position: 6, label: 'SS', left: '43.8%', top: '53.3%', group: 'infield' },
      { position: 4, label: '2B', left: '58.9%', top: '53.5%', group: 'infield' },
      { position: 5, label: '3B', left: '37%', top: '69.4%', group: 'infield' },
      { position: 1, label: 'P',  left: '50.2%', top: '74.6%', group: 'battery' },
      { position: 3, label: '1B', left: '63.1%', top: '70%', group: 'infield' },
      { position: 2, label: 'C',  left: '50.2%', top: '95.7%', group: 'battery' },
    ],
  },
  'bowser_castle': {
    image: '/stadiums/bowser-castle.png',
    aspectRatio: '1322/990',
    homePlate: STADIUM_FIELD_GEOMETRY.bowser_castle.homePlate,
    wallRefs: STADIUM_FIELD_GEOMETRY.bowser_castle.wallRefs,
    positions: [
      { position: 8, label: 'CF', left: '49.3%', top: '38.4%', group: 'outfield' },
      { position: 7, label: 'LF', left: '29.6%', top: '47.7%', group: 'outfield' },
      { position: 9, label: 'RF', left: '68.6%', top: '47.2%', group: 'outfield' },
      { position: 6, label: 'SS', left: '42.4%', top: '58.2%', group: 'infield' },
      { position: 4, label: '2B', left: '57.9%', top: '58.1%', group: 'infield' },
      { position: 5, label: '3B', left: '36.9%', top: '73.6%', group: 'infield' },
      { position: 1, label: 'P',  left: '49.6%', top: '76.6%', group: 'battery' },
      { position: 3, label: '1B', left: '61.4%', top: '73.8%', group: 'infield' },
      { position: 2, label: 'C',  left: '49.5%', top: '94.7%', group: 'battery' },
    ],
  },
  'bowser_jr_playroom': {
    image: '/stadiums/bowser-jr-playroom.png',
    aspectRatio: '1280/992',
    homePlate: STADIUM_FIELD_GEOMETRY.bowser_jr_playroom.homePlate,
    wallRefs: STADIUM_FIELD_GEOMETRY.bowser_jr_playroom.wallRefs,
    positions: [
      { position: 8, label: 'CF', left: '50.1%', top: '37.7%', group: 'outfield' },
      { position: 7, label: 'LF', left: '29.5%', top: '46%', group: 'outfield' },
      { position: 9, label: 'RF', left: '70.6%', top: '46.6%', group: 'outfield' },
      { position: 6, label: 'SS', left: '41.9%', top: '56.4%', group: 'infield' },
      { position: 4, label: '2B', left: '59.4%', top: '56.3%', group: 'infield' },
      { position: 5, label: '3B', left: '36.8%', top: '72.3%', group: 'infield' },
      { position: 1, label: 'P',  left: '50%', top: '76.3%', group: 'battery' },
      { position: 3, label: '1B', left: '62.8%', top: '73%', group: 'infield' },
      { position: 2, label: 'C',  left: '49.9%', top: '95.5%', group: 'battery' },
    ],
  },
  'daisy_cruiser': {
    image: '/stadiums/daisy-cruiser.png',
    aspectRatio: '1218/945',
    homePlate: STADIUM_FIELD_GEOMETRY.daisy_cruiser.homePlate,
    wallRefs: STADIUM_FIELD_GEOMETRY.daisy_cruiser.wallRefs,
    positions: [
      { position: 8, label: 'CF', left: '50.2%', top: '48.9%', group: 'outfield' },
      { position: 7, label: 'LF', left: '33.4%', top: '56.7%', group: 'outfield' },
      { position: 9, label: 'RF', left: '66.7%', top: '56.8%', group: 'outfield' },
      { position: 6, label: 'SS', left: '43.8%', top: '64.9%', group: 'infield' },
      { position: 4, label: '2B', left: '58.8%', top: '64.6%', group: 'infield' },
      { position: 5, label: '3B', left: '39.3%', top: '76.8%', group: 'infield' },
      { position: 1, label: 'P',  left: '50.3%', top: '80.7%', group: 'battery' },
      { position: 3, label: '1B', left: '61.2%', top: '76.6%', group: 'infield' },
      { position: 2, label: 'C',  left: '50.2%', top: '95.9%', group: 'battery' },
    ],
  },
  'peach_ice_garden': {
    image: '/stadiums/peach-ice-garden.png',
    aspectRatio: '1304/915',
    homePlate: STADIUM_FIELD_GEOMETRY.peach_ice_garden.homePlate,
    wallRefs: STADIUM_FIELD_GEOMETRY.peach_ice_garden.wallRefs,
    positions: [
      { position: 8, label: 'CF', left: '50.4%', top: '39.2%', group: 'outfield' },
      { position: 7, label: 'LF', left: '31.2%', top: '48.3%', group: 'outfield' },
      { position: 9, label: 'RF', left: '69%', top: '48.7%', group: 'outfield' },
      { position: 6, label: 'SS', left: '44.1%', top: '58.7%', group: 'infield' },
      { position: 4, label: '2B', left: '58.5%', top: '58.4%', group: 'infield' },
      { position: 5, label: '3B', left: '37.9%', top: '72.9%', group: 'infield' },
      { position: 1, label: 'P',  left: '50.4%', top: '77.4%', group: 'battery' },
      { position: 3, label: '1B', left: '62.8%', top: '73.6%', group: 'infield' },
      { position: 2, label: 'C',  left: '49.9%', top: '96.5%', group: 'battery' },
    ],
  },
  'luigis_mansion': {
    image: "/stadiums/luigi's-mansion.png",
    aspectRatio: '1139/988',
    homePlate: STADIUM_FIELD_GEOMETRY.luigis_mansion.homePlate,
    wallRefs: STADIUM_FIELD_GEOMETRY.luigis_mansion.wallRefs,
    positions: [
      { position: 8, label: 'CF', left: '49.6%', top: '42.7%', group: 'outfield' },
      { position: 7, label: 'LF', left: '29.6%', top: '50.6%', group: 'outfield' },
      { position: 9, label: 'RF', left: '69.4%', top: '50.7%', group: 'outfield' },
      { position: 6, label: 'SS', left: '42.6%', top: '58.5%', group: 'infield' },
      { position: 4, label: '2B', left: '58.6%', top: '58.5%', group: 'infield' },
      { position: 5, label: '3B', left: '36.6%', top: '72.3%', group: 'infield' },
      { position: 1, label: 'P',  left: '49.9%', top: '76.7%', group: 'battery' },
      { position: 3, label: '1B', left: '63.3%', top: '72.3%', group: 'infield' },
      { position: 2, label: 'C',  left: '49.9%', top: '92.7%', group: 'battery' },
    ],
  },
  'generic_field': {
    image: '/stadiums/spray chart.png',
    aspectRatio: '1254/1254',
    homePlate: STADIUM_FIELD_GEOMETRY.generic_field.homePlate,
    wallRefs: STADIUM_FIELD_GEOMETRY.generic_field.wallRefs,
    positions: [
      { position: 8, label: 'CF', left: '50.5%', top: '35.7%', group: 'outfield' },
      { position: 7, label: 'LF', left: '23.9%', top: '47.9%', group: 'outfield' },
      { position: 9, label: 'RF', left: '76.1%', top: '47.9%', group: 'outfield' },
      { position: 6, label: 'SS', left: '39.1%', top: '56.7%', group: 'infield' },
      { position: 4, label: '2B', left: '60.2%', top: '57%', group: 'infield' },
      { position: 5, label: '3B', left: '30.7%', top: '69.5%', group: 'infield' },
      { position: 1, label: 'P',  left: '50%', top: '73.1%', group: 'battery' },
      { position: 3, label: '1B', left: '68.5%', top: '70%', group: 'infield' },
      { position: 2, label: 'C',  left: '49.9%', top: '94%', group: 'battery' },
    ],
  },
}

// Cropped, zoomed-in infield diamond art (public/stadiums/<key>-runners.png)
// used by BaserunnerField for the baserunner diamond — one per stadium, in
// the same orientation every time (home at bottom, 2B at top). Base spot
// percentages come from public/calibrate-runners.html (same click-to-measure
// approach as FieldPlayBuilder's own calibrate.html) — re-run it and paste
// the output here if a runner token ever looks off-base.
export const STADIUM_RUNNER_CONFIGS = {
  mario_stadium: {
    image: '/stadiums/mario-stadium-runners.png',
    bases: { second: { left: '51%', top: '12.1%' }, first: { left: '93.1%', top: '49%' }, third: { left: '8%', top: '49.1%' }, home: { left: '49.9%', top: '91.7%' } },
  },
  yoshi_park: {
    image: '/stadiums/yoshi-park-runners.png',
    bases: { second: { left: '50.2%', top: '9.1%' }, first: { left: '88.1%', top: '47.6%' }, third: { left: '12.4%', top: '47.9%' }, home: { left: '50.2%', top: '90.8%' } },
  },
  wario_city: {
    image: '/stadiums/wario-stadium-runners.png',
    bases: { second: { left: '49.3%', top: '13.1%' }, first: { left: '85.9%', top: '51.6%' }, third: { left: '10.7%', top: '50.3%' }, home: { left: '47.3%', top: '94.6%' } },
  },
  dk_jungle: {
    image: '/stadiums/dk-jungle-runners.png',
    bases: { second: { left: '50%', top: '5.9%' }, first: { left: '96.6%', top: '42.7%' }, third: { left: '4.2%', top: '43.6%' }, home: { left: '51%', top: '88.2%' } },
  },
  bowser_castle: {
    image: '/stadiums/bowser-castle-runners.png',
    bases: { second: { left: '49.6%', top: '9.6%' }, first: { left: '89%', top: '42.9%' }, third: { left: '10.8%', top: '44%' }, home: { left: '50.3%', top: '82.2%' } },
  },
  bowser_jr_playroom: {
    image: '/stadiums/bowser-jr-playroom-runners.png',
    bases: { second: { left: '49.3%', top: '9.1%' }, first: { left: '86.9%', top: '43.5%' }, third: { left: '12.1%', top: '43%' }, home: { left: '49.1%', top: '82.5%' } },
  },
  daisy_cruiser: {
    image: '/stadiums/daisy-cruiser-runners.png',
    bases: { second: { left: '50.3%', top: '8.3%' }, first: { left: '92%', top: '44.4%' }, third: { left: '8.3%', top: '44.2%' }, home: { left: '50.3%', top: '83.4%' } },
  },
  peach_ice_garden: {
    image: '/stadiums/peach-ice-garden-runners.png',
    bases: { second: { left: '50.3%', top: '6.9%' }, first: { left: '95.1%', top: '44.7%' }, third: { left: '5.3%', top: '44.6%' }, home: { left: '50.3%', top: '88.1%' } },
  },
  luigis_mansion: {
    image: "/stadiums/luigi's-mansion-runners.png",
    bases: { second: { left: '49.9%', top: '5.2%' }, first: { left: '96.7%', top: '44.8%' }, third: { left: '3.3%', top: '45.4%' }, home: { left: '50.9%', top: '89.6%' } },
  },
}

// Tap the field once to drop a landing-spot marker, then tap fielders in the
// order they touched the ball. By default tapping a selected fielder again
// removes them; a caller that instead wants to allow the same fielder to
// appear more than once in the chain (e.g. a 3-4-3 double play) can pass
// onFielderContextMenu, which fires on right-click and is the only way to
// remove a fielder in that mode — left-click then always adds another touch.
// Either way this lets a single diagram capture "where it landed" + "who's
// credited" + the play sequence (e.g. 6-3) without separate screens.
//
// A second, independent marker (secondarySpot/onSecondaryTap) can be layered
// on the same diagram via right-click — used by At-Bat Data Entry to capture
// where a ball was actually fielded alongside where it was hit, without
// needing two separate field images. Rendered with a distinct shape/color
// (square vs. the primary marker's circle) so the two stay visually
// distinguishable at a glance.
// Zoom is applied by growing the inner image container's own width (not a
// CSS transform:scale), so its getBoundingClientRect stays the source of
// truth for click-to-percentage math below — no separate coordinate
// remapping needed at any zoom level. 1 is the base/fit view and also the
// floor: you can zoom in past it but never out past the whole field.
const FIELD_ZOOM_MIN = 1
const FIELD_ZOOM_MAX = 3
const FIELD_ZOOM_STEP = 0.15

export default function FieldPlayBuilder({
  fieldersByPosition = {},
  fielderChain = [],
  landingSpot = null,
  onFieldTap,
  onToggleFielder,
  onFielderContextMenu,
  notation = '',
  accent = '#EAB308',
  label = 'Build The Play',
  allowedPositions = null,
  allowFielderSelection = true,
  stadiumKey = null,
  secondarySpot = null,
  onSecondaryTap,
  secondaryAccent = '#38BDF8',
  primaryMarkerLabel = null,
  secondaryMarkerLabel = null,
  showFielderMarkers = true,
}) {
  const viewportRef = useRef(null)
  const containerRef = useRef(null)
  const [zoom, setZoom] = useState(1)
  const zoomRef = useRef(zoom)
  const [isPanning, setIsPanning] = useState(false)
  const allowedSet = allowedPositions ? new Set(allowedPositions.map((position) => String(position))) : null
  const stadiumConfig = stadiumKey ? STADIUM_CONFIGS[stadiumKey] : null
  const activePositions = stadiumConfig?.positions ?? FIELD_POSITIONS
  const fieldImage = stadiumConfig?.image ?? '/baseball-field.jpg'
  const fieldAspectRatio = stadiumConfig?.aspectRatio ?? '1/1.02'

  useEffect(() => {
    zoomRef.current = zoom
  }, [zoom])

  const spotFromEvent = (event) => {
    if (!containerRef.current) return null
    const rect = containerRef.current.getBoundingClientRect()
    const x = Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100))
    const y = Math.min(100, Math.max(0, ((event.clientY - rect.top) / rect.height) * 100))
    return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }
  }

  const handleFieldClick = (event) => {
    const spot = spotFromEvent(event)
    if (spot) onFieldTap?.(spot)
  }

  const handleFieldContextMenu = (event) => {
    if (!onSecondaryTap) return
    event.preventDefault()
    const spot = spotFromEvent(event)
    if (spot) onSecondaryTap(spot)
  }

  // Scroll-to-zoom, scoped to this diagram only. Attached as a real DOM
  // listener (not React's onWheel) with { passive: false } — React attaches
  // JSX onWheel handlers as passive, which silently no-ops preventDefault()
  // and was letting the browser's native scroll fire on this same
  // scrollable element right alongside the zoom, panning it unintentionally
  // on every wheel tick. A native listener is the only way to actually stop
  // that default scroll here. Zooms toward the cursor: the image point
  // under the pointer stays put by adjusting scroll offset to match the
  // new (larger/smaller) content size. Clamped at FIELD_ZOOM_MIN (1) — you
  // can never zoom out past the whole field.
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return undefined

    // A single scroll gesture fires many wheel events in quick succession
    // (trackpads especially) — applying a resize on every one of them was
    // forcing the browser to re-layout/re-decode this (often large) image
    // faster than it could keep up, which is what showed up as flashing.
    // Coalescing into at most one zoom step per animation frame fixes that
    // without changing the step size or feel.
    let pendingDeltaY = 0
    let lastCursor = null
    let rafId = null

    function applyPendingZoom() {
      rafId = null
      const delta = pendingDeltaY
      pendingDeltaY = 0
      if (delta === 0 || !lastCursor) return
      const currentZoom = zoomRef.current
      const rect = viewport.getBoundingClientRect()
      const { cursorXRatio, cursorYRatio } = lastCursor
      const direction = delta < 0 ? 1 : -1
      const nextZoom = Math.min(FIELD_ZOOM_MAX, Math.max(FIELD_ZOOM_MIN, Math.round((currentZoom + direction * FIELD_ZOOM_STEP) * 100) / 100))
      if (nextZoom === currentZoom) return
      const contentX = viewport.scrollLeft + cursorXRatio * rect.width
      const contentY = viewport.scrollTop + cursorYRatio * rect.height
      const scaleRatio = nextZoom / currentZoom
      setZoom(nextZoom)
      requestAnimationFrame(() => {
        viewport.scrollLeft = contentX * scaleRatio - cursorXRatio * rect.width
        viewport.scrollTop = contentY * scaleRatio - cursorYRatio * rect.height
      })
    }

    function onWheel(event) {
      event.preventDefault()
      const rect = viewport.getBoundingClientRect()
      pendingDeltaY += event.deltaY
      lastCursor = {
        cursorXRatio: (event.clientX - rect.left) / rect.width,
        cursorYRatio: (event.clientY - rect.top) / rect.height,
      }
      if (rafId == null) rafId = requestAnimationFrame(applyPendingZoom)
    }

    viewport.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      viewport.removeEventListener('wheel', onWheel)
      if (rafId != null) cancelAnimationFrame(rafId)
    }
  }, [])

  // Middle-mouse-button drag to pan once zoomed in — the other way to move
  // around besides dragging the scrollbars directly, since the wheel is
  // reserved for zoom only (see above) and left-click is already spoken for
  // (placing hit/fielded markers).
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return undefined

    function onMouseDown(event) {
      if (event.button !== 1) return
      event.preventDefault()
      const startX = event.clientX
      const startY = event.clientY
      const startScrollLeft = viewport.scrollLeft
      const startScrollTop = viewport.scrollTop
      setIsPanning(true)

      function onMouseMove(moveEvent) {
        viewport.scrollLeft = startScrollLeft - (moveEvent.clientX - startX)
        viewport.scrollTop = startScrollTop - (moveEvent.clientY - startY)
      }
      function onMouseUp() {
        setIsPanning(false)
        document.removeEventListener('mousemove', onMouseMove)
        document.removeEventListener('mouseup', onMouseUp)
      }
      document.addEventListener('mousemove', onMouseMove)
      document.addEventListener('mouseup', onMouseUp)
    }

    viewport.addEventListener('mousedown', onMouseDown)
    return () => viewport.removeEventListener('mousedown', onMouseDown)
  }, [])

  const showMarkerLegend = Boolean(onSecondaryTap || secondarySpot)

  return (
    <div>
      {(label || notation || showMarkerLegend) ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 8, flexWrap: 'wrap' }}>
          {label ? <div style={{ fontSize: 12, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase' }}>{label}</div> : <span />}
          {showMarkerLegend ? (
            <div style={{ display: 'flex', gap: 12, fontSize: 10, fontWeight: 700 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: accent }}>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: accent, display: 'inline-block' }} />
                {primaryMarkerLabel || (onSecondaryTap ? 'Left-click: hit' : 'Hit')}
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: secondaryAccent }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: secondaryAccent, display: 'inline-block' }} />
                {secondaryMarkerLabel || (onSecondaryTap ? 'Right-click: fielded' : 'Fielded')}
              </span>
            </div>
          ) : null}
          {notation ? (
            <div style={{ fontSize: 16, fontWeight: 800, color: accent, letterSpacing: '.04em' }}>{notation}</div>
          ) : null}
        </div>
      ) : null}
      <div style={{ position: 'relative', width: '100%', maxWidth: stadiumConfig ? 480 : 320, margin: '0 auto' }}>
      <div
        ref={viewportRef}
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: fieldAspectRatio,
          border: stadiumConfig ? 'none' : '1.5px solid rgba(148,163,184,0.35)',
          borderRadius: 18,
          // 'visible' at the base zoom so distance-label text that pokes a
          // few px past the image edge (near-the-fence taps) isn't clipped
          // like it would be under 'auto' — only switches to a real
          // scrollable clip once there's actually zoomed content to pan.
          overflow: zoom > FIELD_ZOOM_MIN ? 'auto' : 'visible',
          cursor: isPanning ? 'grabbing' : undefined,
        }}
      >
        <div
          ref={containerRef}
          onClick={handleFieldClick}
          onContextMenu={handleFieldContextMenu}
          role="button"
          tabIndex={0}
          style={{
            position: 'relative',
            width: '100%',
            // A GPU-composited transform instead of an actual width resize —
            // resizing the real box forces the browser to re-layout and
            // re-rasterize the (often large) stadium image on every zoom
            // step, which is what was flashing. Scaling the already-painted
            // layer instead has nothing to re-decode. getBoundingClientRect()
            // (used by spotFromEvent below) already reflects the transformed
            // size/position, so the click math needs no changes for this.
            transform: `scale(${zoom})`,
            transformOrigin: '0 0',
            // Without this hint, the browser can still drop the layer
            // between transform updates and re-rasterize the image from
            // scratch on the next one — same flash as the width-resize
            // approach, just from a different cause. This keeps it
            // permanently promoted to its own GPU layer so scaling only
            // ever recomposites, never repaints.
            willChange: 'transform',
            cursor: onFieldTap || onSecondaryTap ? 'crosshair' : 'default',
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
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: `${accent}33`,
                  border: `1.5px solid ${accent}`,
                  transform: 'translate(-50%, -50%)',
                  pointerEvents: 'none',
                  boxShadow: `0 0 0 2px ${accent}1A`,
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
        {secondarySpot ? (() => {
          const dist = estimateHitDistance(secondarySpot, stadiumConfig)
          return (
            <>
              <div
                style={{
                  position: 'absolute',
                  left: `${secondarySpot.x}%`,
                  top: `${secondarySpot.y}%`,
                  width: 7,
                  height: 7,
                  borderRadius: 2,
                  background: `${secondaryAccent}33`,
                  border: `1.5px solid ${secondaryAccent}`,
                  transform: 'translate(-50%, -50%) rotate(45deg)',
                  pointerEvents: 'none',
                  boxShadow: `0 0 0 2px ${secondaryAccent}1A`,
                }}
              />
              {dist != null ? (
                <div
                  style={{
                    position: 'absolute',
                    left: `${secondarySpot.x}%`,
                    top: `${secondarySpot.y}%`,
                    transform: 'translate(10px, -50%)',
                    pointerEvents: 'none',
                    fontSize: 11,
                    fontWeight: 800,
                    color: secondaryAccent,
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
        {showFielderMarkers && activePositions.map((slot) => {
          const fielder = fieldersByPosition[String(slot.position)] || null
          const chainIndex = fielderChain.indexOf(String(slot.position))
          const selected = chainIndex !== -1
          const disabled = !allowFielderSelection || (allowedSet ? !allowedSet.has(String(slot.position)) : false)
          const portraitSize = stadiumConfig ? 32 : 36
          const badgeSize = stadiumConfig ? 15 : 17
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
              onContextMenu={(event) => {
                event.preventDefault()
                event.stopPropagation()
                if (disabled || !onFielderContextMenu) return
                onFielderContextMenu(String(slot.position))
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
              <div style={{ fontSize: stadiumConfig ? 8 : 9, fontWeight: 800, color: selected ? accent : disabled ? '#475569' : '#F8FAFC', marginTop: 1, textShadow: '0 1px 2px rgba(0,0,0,0.7)' }}>
                {slot.label}
              </div>
            </button>
          )
        })}
        </div>
      </div>
      {zoom > FIELD_ZOOM_MIN ? (
        <button
          type="button"
          onClick={() => setZoom(FIELD_ZOOM_MIN)}
          title="Reset zoom"
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            zIndex: 1,
            padding: '3px 8px',
            borderRadius: 999,
            border: '1px solid rgba(148,163,184,0.4)',
            background: 'rgba(15,23,42,0.85)',
            color: '#F8FAFC',
            fontSize: 10,
            fontWeight: 800,
            cursor: 'pointer',
          }}
        >
          {Math.round(zoom * 100)}% ↺
        </button>
      ) : null}
      </div>
    </div>
  )
}
