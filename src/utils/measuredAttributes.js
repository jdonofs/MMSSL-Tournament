// Pairs what the game's own data says about a character (the data-mined talent profile) with
// what the preview tracker actually measured them doing.
//
// The two sides are in different units on purpose -- `run_speed` is a 0-100 game attribute and
// sprint speed is feet per second -- so a raw subtraction is meaningless. Every comparison here
// is a PERCENTILE delta against the full cast: "the game rates him the 78th-percentile runner,
// we measured him 41st, so he is running 37 points below his rating." That is the same question
// scripts/verify_speed_against_attributes.mjs asks, and it is the only framing under which a
// mined attribute and a measured quantity can disagree in a way that means something.
//
// A large negative delta across MANY characters is a broken metric, not a slow cast. Fielder
// sprint speed once correlated with the game's own run_speed attribute at -0.66 while looking
// perfectly reasonable per-character.

import { percentileOfValue } from './statsCalculator'
import { characterNameKey } from './characterNames'
import {
  aggregateArmStrength,
  summarizeAdvancedBaserunning,
  summarizeAdvancedFielding,
  summarizeMovementMetrics,
} from './advancedDefense'
import { getCharacterTalentProfile } from './characterAnalysis'

function finite(value) {
  // Number(null) is 0, and 0 is finite. Without the null guard every unmeasured column reads
  // 0.0 and then ranks in the 100th percentile, because the entire cast shares that fake zero.
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function mean(values) {
  const clean = values.filter((v) => Number.isFinite(v))
  return clean.length ? clean.reduce((sum, v) => sum + v, 0) / clean.length : null
}

function usable(rows = []) {
  return rows.filter((row) => row?.quality?.quarantined_session !== true)
}

// ─── Measured pitching ───────────────────────────────────────────────────────
//
// `pitches.pitcher_id` is a NAME STRING, not a character_id (see the note in
// src/components/BettingTab.jsx). It has to be resolved through characterNames.js -- a
// lowercase or exact match silently drops the six characters the capture and the site spell
// differently, and they would read as having never thrown a pitch.
export function summarizeMeasuredPitching(pitchRows = [], characterIdByNameKey = new Map()) {
  const byCharacter = new Map()
  for (const row of pitchRows) {
    const charId = characterIdByNameKey.get(characterNameKey(row?.pitcher_id))
    if (charId == null) continue
    if (!byCharacter.has(charId)) byCharacter.set(charId, [])
    byCharacter.get(charId).push(row)
  }

  return Object.fromEntries([...byCharacter].map(([charId, rows]) => {
    const speeds = rows.map((row) => finite(row.pitch_speed_mph)).filter((v) => v != null)
    // Break is the pitch's deviation from the straight line between release and plate, which is
    // exactly what the chord-deviation columns hold. The horizontal and vertical components are
    // combined as a magnitude so one number can stand against the mined `curve` rating.
    const breaks = rows.map((row) => {
      const h = finite(row.pitch_horizontal_chord_deviation_units)
      const v = finite(row.pitch_vertical_chord_deviation_units)
      if (h == null && v == null) return null
      return Math.hypot(h ?? 0, v ?? 0)
    }).filter((v) => v != null)

    return [String(charId), {
      pitchSpeedMph: mean(speeds),
      maxPitchSpeedMph: speeds.length ? Math.max(...speeds) : null,
      pitchSpeedSamples: speeds.length,
      breakUnits: mean(breaks),
      breakSamples: breaks.length,
    }]
  }))
}

// ─── Measured fielding extras ────────────────────────────────────────────────
//
// summarizeAdvancedFielding already returns OAA, arm value and positioning, but not the two
// per-opportunity route numbers, which are the closest measured analogue to the mined
// `mobility` metric.
function summarizeRouteMetrics(fieldingRows = []) {
  const byCharacter = new Map()
  for (const row of usable(fieldingRows)) {
    const charId = row?.fielder_character_id
    if (charId == null) continue
    if (!byCharacter.has(charId)) byCharacter.set(charId, [])
    byCharacter.get(charId).push(row)
  }

  return Object.fromEntries([...byCharacter].map(([charId, rows]) => {
    const routes = rows.map((row) => finite(row.route_efficiency)).filter((v) => v != null)
    const reactions = rows.map((row) => finite(row.reaction_seconds)).filter((v) => v != null)
    return [String(charId), {
      routeEfficiency: mean(routes),
      routeSamples: routes.length,
      reactionSeconds: mean(reactions),
      reactionSamples: reactions.length,
    }]
  }))
}

// ─── The measured index ──────────────────────────────────────────────────────
//
// One row per character, holding every tracker-measured quantity the Scouting Report can show.
// Built cast-wide, not per-character, because percentiles need the whole population.
export function buildMeasuredIndex({
  movementRows = [],
  fieldingRows = [],
  throwRows = [],
  runnerRows = [],
  pitchRows = [],
  leaguePerformanceByCharacterId = {},
  characterIdByNameKey = new Map(),
} = {}) {
  const movement = summarizeMovementMetrics(movementRows, 'character')
  const fielding = summarizeAdvancedFielding(
    { throws: throwRows, fieldingOpportunities: fieldingRows },
    'character',
  )
  const routes = summarizeRouteMetrics(fieldingRows)
  const running = summarizeAdvancedBaserunning(runnerRows, 'character')
  const pitching = summarizeMeasuredPitching(pitchRows, characterIdByNameKey)

  const ids = new Set([
    ...Object.keys(movement),
    ...Object.keys(fielding),
    ...Object.keys(routes),
    ...Object.keys(running),
    ...Object.keys(pitching),
    ...Object.keys(leaguePerformanceByCharacterId),
  ].map(String))

  return Object.fromEntries([...ids].map((id) => {
    const move = movement[id] || {}
    const field = fielding[id] || {}
    const route = routes[id] || {}
    const base = running[id] || {}
    const pitch = pitching[id] || {}
    const perf = leaguePerformanceByCharacterId[id] || {}
    const arm = field.throws != null ? field : aggregateArmStrength([])

    return [id, {
      // Running
      sprintSpeedFps: move.sprintSpeedFps ?? null,
      maxSprintSpeedFps: move.maxSprintSpeedFps ?? null,
      speedSamples: move.speedSamples ?? 0,
      bolts: move.speedSamples ? move.bolts : null,
      homeToFirstSeconds: move.homeToFirstSeconds ?? null,
      homeToFirstSamples: move.homeToFirstSamples ?? 0,
      ninetyFootSplitSeconds: move.ninetyFootSplitSeconds ?? null,
      jumpDistanceFeet: move.jumpDistanceFeet ?? null,
      jumpReactionFeet: move.jumpReactionFeet ?? null,
      jumpBurstFeet: move.jumpBurstFeet ?? null,
      jumpSamples: move.jumpSamples ?? 0,

      // Fielding
      outsAboveAverage: field.fieldingOpportunities ? field.outsAboveAverage : null,
      fieldingOpportunities: field.fieldingOpportunities ?? 0,
      actualOuts: field.fieldingOpportunities ? field.actualOuts : null,
      expectedOuts: field.expectedOuts ?? 0,
      catchConversion: field.expectedOuts > 0 ? field.actualOuts / field.expectedOuts : null,
      fieldingRunValue: (field.fieldingOpportunities || field.armOpportunities || field.doublePlayOpportunities)
        ? field.fieldingRunValue
        : null,
      averagePositionDepthFeet: field.positioningSamples ? field.averagePositionDepthFeet : null,
      averagePositionAngleDeg: field.averagePositionAngleDeg ?? null,
      positioningSamples: field.positioningSamples ?? 0,
      routeEfficiency: route.routeEfficiency ?? null,
      routeSamples: route.routeSamples ?? 0,
      reactionSeconds: route.reactionSeconds ?? null,
      reactionSamples: route.reactionSamples ?? 0,

      // Throwing
      armStrengthMph: arm.armStrengthMph ?? null,
      hardestThrowMph: arm.hardestThrowMph ?? null,
      throwSamples: arm.throws ?? 0,
      buddyThrows: arm.buddyThrows ?? 0,
      hardestBuddyThrowMph: arm.hardestBuddyThrowMph ?? null,
      armOpportunities: field.armOpportunities ?? 0,
      armHolds: field.armOpportunities ? field.armHolds : null,
      armAdvances: field.armOpportunities ? field.armAdvances : null,
      armKills: field.armOpportunities ? field.armKills : null,
      armValue: field.armOpportunities ? field.armValue : null,
      doublePlaysAdded: field.doublePlayOpportunities ? field.doublePlaysAdded : null,
      doublePlayOpportunities: field.doublePlayOpportunities ?? 0,

      // Baserunning
      baserunningRunValue: base.opportunities ? base.baserunningRunValue : null,
      baserunningOpportunities: base.opportunities ?? 0,

      // Pitching
      pitchSpeedMph: pitch.pitchSpeedMph ?? null,
      maxPitchSpeedMph: pitch.maxPitchSpeedMph ?? null,
      pitchSpeedSamples: pitch.pitchSpeedSamples ?? 0,
      breakUnits: pitch.breakUnits ?? null,
      breakSamples: pitch.breakSamples ?? 0,

      // Batting (already derived league-wide from plate appearances)
      exitVelo: perf.exitVelo ?? null,
      exitVeloSamples: perf.exitVeloSamples ?? 0,
      paSamples: perf.paSamples ?? 0,
      barrelRate: perf.barrelRate ?? null,
      hardHitRate: perf.hardHitRate ?? null,
      whiffRate: perf.whiffRate ?? null,
      kRate: perf.kRate ?? null,
      bbRate: perf.bbRate ?? null,
      xwoba: perf.xwoba ?? null,
    }]
  }))
}

// ─── The mined index ─────────────────────────────────────────────────────────
//
// Straight off the data-mined talent profile, plus the derived metrics analyzeCharacterTalent
// already computes. Characters with no profile (Miis without a mapping) fall back to the
// `characters` table columns, which hold the same attributes under different names.
export function buildMinedIndex(characters = [], analysesByCharacterId = {}) {
  return Object.fromEntries(characters.map((character) => {
    const profile = getCharacterTalentProfile(character.name) || {}
    const analysis = analysesByCharacterId[character.id] || null
    const raw = analysis?.rawMetrics || {}

    const num = (profileValue, columnValue) => finite(profileValue) ?? finite(columnValue)

    return [String(character.id), {
      chargePower: num(profile.chargePower, character.charge_power),
      slapPower: num(profile.slapPower, character.slap_power),
      chargeContact: num(profile.chargeContact, character.charge_contact),
      slapContact: num(profile.slapContact, character.slap_contact),
      contact: raw.batting?.contact ?? null,
      contactPerfectWindow: raw.batting?.contactPerfectWindow ?? null,
      contactForgiveness: raw.batting?.contactForgiveness ?? null,
      plateCoverage: raw.batting?.plateCoverage ?? null,
      baserunning: raw.batting?.baserunning ?? null,
      bunting: num(profile.bunting, character.bunting),

      fastballSpeed: num(profile.fastballSpeed, character.fastball_speed),
      curveballSpeed: num(profile.curveballSpeed, character.curveball_speed),
      curve: num(profile.curve, character.curve),
      stamina: num(profile.stamina, character.stamina),
      velocityIndex: analysis?.intrinsics?.velocityIndex ?? null,
      breakIndex: analysis?.intrinsics?.breakIndex ?? null,

      fielding: num(profile.fielding, character.fielding_stat ?? character.fielding),
      throwingSpeed: num(profile.throwingSpeed, character.throwing_speed),
      catchCoverage: raw.fielding?.catchCoverage ?? null,
      mobility: raw.fielding?.mobility ?? null,
      baseDefense: raw.fielding?.baseDefense ?? null,

      runSpeed: num(profile.runSpeed, character.run_speed ?? character.speed),
      speedRating: analysis?.displayRatings?.speed ?? null,
    }]
  }))
}

// ─── The registry ────────────────────────────────────────────────────────────
//
// `mined` and `measured` are both optional. A row with only one side renders a dash in the
// other column and has no delta -- that absence is information, so unpaired rows stay in the
// same table rather than being hidden in a separate block.
//
// `invert: true` on a measured field means lower is better (home-to-first, reaction time), so
// its percentile is flipped before the delta is taken.
export const RAW_VALUE_ROWS = [
  // ── Batting ──────────────────────────────────────────────────────────────
  {
    key: 'power', label: 'Power', group: 'Batting',
    mined: { field: 'chargePower', digits: 0 },
    measured: { field: 'exitVelo', samples: 'exitVeloSamples', unit: 'mph', digits: 1 },
  },
  {
    key: 'contact', label: 'Contact', group: 'Batting',
    mined: { field: 'contact', digits: 1 },
    measured: { field: 'whiffRate', samples: 'paSamples', unit: '%', digits: 1, invert: true, label: 'Whiff %' },
  },
  { key: 'slapPower', label: 'Slap Power', group: 'Batting', mined: { field: 'slapPower', digits: 0 } },
  { key: 'chargeContact', label: 'Charge Contact', group: 'Batting', mined: { field: 'chargeContact', digits: 0 } },
  { key: 'slapContact', label: 'Slap Contact', group: 'Batting', mined: { field: 'slapContact', digits: 0 } },
  { key: 'contactPerfectWindow', label: 'Contact Window', group: 'Batting', mined: { field: 'contactPerfectWindow', digits: 0 } },
  { key: 'contactForgiveness', label: 'Contact Forgiveness', group: 'Batting', mined: { field: 'contactForgiveness', digits: 1 } },
  { key: 'plateCoverage', label: 'Plate Coverage', group: 'Batting', mined: { field: 'plateCoverage', digits: 0 } },
  { key: 'bunting', label: 'Bunting', group: 'Batting', mined: { field: 'bunting', digits: 0 } },
  { key: 'barrelRate', label: 'Barrel %', group: 'Batting', measured: { field: 'barrelRate', samples: 'exitVeloSamples', unit: '%', digits: 1 } },
  { key: 'hardHitRate', label: 'Hard-Hit %', group: 'Batting', measured: { field: 'hardHitRate', samples: 'exitVeloSamples', unit: '%', digits: 1 } },
  { key: 'bbRate', label: 'BB %', group: 'Batting', measured: { field: 'bbRate', samples: 'paSamples', unit: '%', digits: 1 } },
  { key: 'kRate', label: 'K %', group: 'Batting', measured: { field: 'kRate', samples: 'paSamples', unit: '%', digits: 1, invert: true } },

  // ── Pitching ─────────────────────────────────────────────────────────────
  {
    key: 'velocity', label: 'Fastball Velocity', group: 'Pitching',
    mined: { field: 'fastballSpeed', digits: 0 },
    measured: { field: 'pitchSpeedMph', samples: 'pitchSpeedSamples', unit: 'mph', digits: 1 },
  },
  {
    key: 'curve', label: 'Curve', group: 'Pitching',
    mined: { field: 'curve', digits: 0 },
    measured: { field: 'breakUnits', samples: 'breakSamples', unit: 'u', digits: 2, label: 'Break' },
  },
  { key: 'curveballSpeed', label: 'Curveball Speed', group: 'Pitching', mined: { field: 'curveballSpeed', digits: 0 } },
  { key: 'stamina', label: 'Stamina', group: 'Pitching', mined: { field: 'stamina', digits: 0 } },
  { key: 'velocityIndex', label: 'Velocity Index', group: 'Pitching', mined: { field: 'velocityIndex', digits: 0 } },
  { key: 'breakIndex', label: 'Break Index', group: 'Pitching', mined: { field: 'breakIndex', digits: 0 } },
  { key: 'maxPitchSpeed', label: 'Max Pitch Speed', group: 'Pitching', measured: { field: 'maxPitchSpeedMph', samples: 'pitchSpeedSamples', unit: 'mph', digits: 1 } },

  // ── Fielding ─────────────────────────────────────────────────────────────
  {
    key: 'fielding', label: 'Fielding', group: 'Fielding',
    mined: { field: 'fielding', digits: 0 },
    measured: { field: 'outsAboveAverage', samples: 'fieldingOpportunities', unit: '', digits: 1, label: 'OAA' },
  },
  {
    key: 'armStrength', label: 'Arm Strength', group: 'Fielding',
    mined: { field: 'throwingSpeed', digits: 0 },
    measured: { field: 'armStrengthMph', samples: 'throwSamples', unit: 'mph', digits: 1 },
  },
  {
    key: 'catchCoverage', label: 'Catch Coverage', group: 'Fielding',
    mined: { field: 'catchCoverage', digits: 0 },
    measured: { field: 'catchConversion', samples: 'fieldingOpportunities', unit: '×', digits: 2, label: 'Catch Conversion' },
  },
  {
    key: 'mobility', label: 'Mobility', group: 'Fielding',
    mined: { field: 'mobility', digits: 0 },
    measured: { field: 'routeEfficiency', samples: 'routeSamples', unit: '', digits: 3, label: 'Route Efficiency' },
  },
  { key: 'baseDefense', label: 'Base Defense', group: 'Fielding', mined: { field: 'baseDefense', digits: 0 } },
  { key: 'hardestThrow', label: 'Hardest Throw', group: 'Fielding', measured: { field: 'hardestThrowMph', samples: 'throwSamples', unit: 'mph', digits: 1 } },
  { key: 'reaction', label: 'Reaction', group: 'Fielding', measured: { field: 'reactionSeconds', samples: 'reactionSamples', unit: 's', digits: 2, invert: true } },
  { key: 'jumpDistance', label: 'Jump Distance', group: 'Fielding', measured: { field: 'jumpDistanceFeet', samples: 'jumpSamples', unit: 'ft', digits: 1 } },
  { key: 'jumpBurst', label: 'Jump Burst', group: 'Fielding', measured: { field: 'jumpBurstFeet', samples: 'jumpSamples', unit: 'ft', digits: 1 } },
  { key: 'armValue', label: 'Arm Run Value', group: 'Fielding', measured: { field: 'armValue', samples: 'armOpportunities', unit: '', digits: 2 } },
  { key: 'armKills', label: 'Runners Thrown Out', group: 'Fielding', measured: { field: 'armKills', samples: 'armOpportunities', unit: '', digits: 0 } },
  { key: 'doublePlaysAdded', label: 'Double Plays Added', group: 'Fielding', measured: { field: 'doublePlaysAdded', samples: 'doublePlayOpportunities', unit: '', digits: 2 } },
  { key: 'positionDepth', label: 'Avg Position Depth', group: 'Fielding', measured: { field: 'averagePositionDepthFeet', samples: 'positioningSamples', unit: 'ft', digits: 1 } },

  // ── Running ──────────────────────────────────────────────────────────────
  {
    key: 'runSpeed', label: 'Run Speed', group: 'Running',
    mined: { field: 'runSpeed', digits: 0 },
    measured: { field: 'sprintSpeedFps', samples: 'speedSamples', unit: 'ft/s', digits: 1, label: 'Sprint Speed' },
  },
  { key: 'baserunning', label: 'Baserunning', group: 'Running', mined: { field: 'baserunning', digits: 1 } },
  { key: 'maxSprint', label: 'Max Sprint Speed', group: 'Running', measured: { field: 'maxSprintSpeedFps', samples: 'speedSamples', unit: 'ft/s', digits: 1 } },
  { key: 'homeToFirst', label: 'Home to First', group: 'Running', measured: { field: 'homeToFirstSeconds', samples: 'homeToFirstSamples', unit: 's', digits: 2, invert: true } },
  { key: 'ninetyFoot', label: '90-ft Split', group: 'Running', measured: { field: 'ninetyFootSplitSeconds', samples: 'homeToFirstSamples', unit: 's', digits: 2, invert: true } },
  { key: 'bolts', label: 'Bolts', group: 'Running', measured: { field: 'bolts', samples: 'speedSamples', unit: '', digits: 0 } },
]

function sideValue(spec, source) {
  if (!spec || !source) return null
  const raw = finite(source[spec.field])
  if (raw == null) return null
  return spec.scale ? raw * spec.scale : raw
}

// Builds every raw-value row for one character, with each side's percentile against the full
// cast and the delta between them. `delta` is null unless BOTH sides produced a percentile --
// a comparison needs two things to compare.
export function buildRawValueRows(characterId, minedIndex = {}, measuredIndex = {}) {
  const id = String(characterId)
  const mined = minedIndex[id] || null
  const measured = measuredIndex[id] || null
  const minedValues = Object.values(minedIndex)
  const measuredValues = Object.values(measuredIndex)

  return RAW_VALUE_ROWS.map((row) => {
    const minedValue = sideValue(row.mined, mined)
    const measuredValue = sideValue(row.measured, measured)

    const minedPct = row.mined
      ? percentileOfValue(minedValue, minedValues.map((m) => sideValue(row.mined, m)), { invert: Boolean(row.mined.invert) })
      : null
    const measuredPct = row.measured
      ? percentileOfValue(measuredValue, measuredValues.map((m) => sideValue(row.measured, m)), { invert: Boolean(row.measured.invert) })
      : null

    const samples = (measuredValue != null && row.measured?.samples && measured)
      ? finite(measured[row.measured.samples]) ?? 0
      : null

    return {
      key: row.key,
      label: row.label,
      group: row.group,
      minedValue,
      minedPercentile: minedPct,
      minedDigits: row.mined?.digits ?? 0,
      measuredValue,
      measuredPercentile: measuredPct,
      measuredDigits: row.measured?.digits ?? 1,
      measuredUnit: row.measured?.unit ?? '',
      measuredLabel: row.measured?.label || null,
      samples,
      // Positive: the tracker measured them ABOVE what the game's own attribute implies.
      delta: (minedPct != null && measuredPct != null) ? measuredPct - minedPct : null,
    }
  })
}
