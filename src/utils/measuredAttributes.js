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
  FEET_PER_SECOND_TO_MPH,
  METRES_TO_FEET,
  aggregateArmStrength,
  summarizeAdvancedBaserunning,
  summarizeAdvancedFielding,
  summarizeCatchReach,
  summarizeMovementMetrics,
} from './advancedDefense'
import {
  getCharacterCatchMechanics,
  getCharacterTalentProfile,
  resolveCharacterRunSpeed,
} from './characterAnalysis'
import { SPEED_CURVE_VALIDATION, getBaserunSpeed, getFieldSpeed } from '../data/gameSpeedCurves'

// How many SECURED catches a per-character reach number needs before it is
// shown. The displayed value is a quantile over the catches that were held, so
// this has to count those and not attempts: a bucket of six attempts holding
// one catch was rendering that single separation as a "90th percentile" with
// n=6 beside it, which is one observation wearing a statistic's clothes.
//
// Attempts are still reported -- they are what bounds a reach from above -- but
// they are a different denominator and are labelled as one.
export const MIN_CATCH_REACH_SECURED = 6

/** @deprecated the threshold counts secured catches; use MIN_CATCH_REACH_SECURED. */
export const MIN_CATCH_REACH_WINDOWS = MIN_CATCH_REACH_SECURED

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
  catchRows = [],
  leaguePerformanceByCharacterId = {},
  characterIdByNameKey = new Map(),
  // run_speed per character id. Without it the max-speed constant cannot be
  // told apart from its boosted variant and is reported as unclassified --
  // never silently as ordinary.
  speedStatByCharacterId = new Map(),
} = {}) {
  const movement = summarizeMovementMetrics(movementRows, 'character', { speedStatByCharacterId })
  const reach = summarizeCatchReach(catchRows, 'character')
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
    ...Object.keys(reach),
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
    const reaches = reach[id]?.approaches || {}
    // The displayed reach is a quantile over SECURED catches, so the gate
    // counts secured catches. Gating on attempts let a bucket of six attempts
    // and one catch publish that one separation as a percentile.
    const enoughSecured = (bucket, value) => (
      bucket && bucket.secured >= MIN_CATCH_REACH_SECURED ? value ?? null : null
    )
    // Conversion and the shortest failed reach are properties of the ATTEMPTS,
    // so they keep the attempt denominator. Different question, different gate.
    const enoughAttempts = (bucket, value) => (
      bucket && bucket.attempts >= MIN_CATCH_REACH_SECURED ? value ?? null : null
    )

    return [id, {
      // ── Capacity, not performance ──────────────────────────────────────
      // The game's own top-speed constant for this character. It is identical
      // on every play, so it is not a measurement of effort like the sprint
      // numbers beside it -- see summarizeMovementMetrics.
      //
      // AN UNCHECKED OBSERVATION IS NOT THE ORDINARY CONSTANT. The aggregator
      // still hands back the modal value when it had no rating to classify
      // against, because a caller may hold one and no roster row. This index
      // feeds a PERCENTILE against the rest of the cast and a difference
      // against the published curve, and neither is honest about a value
      // nobody checked -- so an unclassified character's constant moves to
      // `maxSpeedUnverifiedFps` and `maxSpeedFps` stays null. The count moves
      // with it; `maxSpeedObservedSamples` still says how many rows there were.
      maxSpeedFps: move.maxSpeedClassified ? (move.maxSpeedFps ?? null) : null,
      maxSpeedSamples: move.maxSpeedClassified ? (move.maxSpeedSamples ?? 0) : 0,
      maxSpeedUnverifiedFps: move.maxSpeedClassified ? null : (move.maxSpeedFps ?? null),
      maxSpeedBoostedFps: move.maxSpeedBoostedFps ?? null,
      maxSpeedBoostedSamples: move.maxSpeedBoostedSamples ?? 0,
      maxSpeedUnclassifiedSamples: move.maxSpeedUnclassifiedSamples ?? 0,
      maxSpeedObservedSamples: move.maxSpeedObservedSamples ?? 0,
      maxSpeedClassified: move.maxSpeedClassified ?? false,
      maxSpeedDistinctValues: move.maxSpeedDistinctValues ?? 0,

      // ── Catch reach, in world units ────────────────────────────────────
      //
      // `...ReachSamples` is the SECURED count, because it is the denominator
      // of the number displayed beside it. `...ReachAttempts` is the wider
      // count -- every window including the ones that came up empty -- and is
      // what says whether a character has been tried at all.
      ordinaryReachUnits: enoughSecured(reaches.ordinary, reaches.ordinary?.reachSecuredP90),
      ordinaryReachSamples: reaches.ordinary?.secured ?? 0,
      ordinaryReachAttempts: reaches.ordinary?.attempts ?? 0,
      ordinaryReachFailedMin: enoughAttempts(reaches.ordinary, reaches.ordinary?.reachFailedMin),
      ordinaryReachConversion: enoughAttempts(reaches.ordinary, reaches.ordinary?.conversion),
      diveReachUnits: enoughSecured(reaches.dive, reaches.dive?.reachSecuredP90),
      diveReachSamples: reaches.dive?.secured ?? 0,
      diveReachAttempts: reaches.dive?.attempts ?? 0,
      diveReachFailedMin: enoughAttempts(reaches.dive, reaches.dive?.reachFailedMin),
      diveReachConversion: enoughAttempts(reaches.dive, reaches.dive?.conversion),
      leapReachUnits: enoughSecured(reaches.leap, reaches.leap?.reachSecuredP90),
      leapReachSamples: reaches.leap?.secured ?? 0,
      leapReachAttempts: reaches.leap?.attempts ?? 0,
      catchReachExcludedWindows: reach[id]?.excludedWindows ?? 0,

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

    // ── The static side of the two new fielding traits ────────────────────
    //
    // The fielding curve is the one validated against the game's own memory,
    // so `fieldTopSpeedFps` is an EXPECTATION the measured constant can be
    // held against directly -- same quantity, same unit, once the curve's
    // units-per-second are put into feet.
    //
    // The baserunning curve is published from the same workbook and has never
    // been checked against anything (SPEED_CURVE_VALIDATION says so). It is
    // carried as a static-only number with no measured counterpart, which is
    // the honest presentation, and deliberately NOT paired with sprint speed:
    // measured runner sprint sits a median 1.14x this curve (p10 1.12, p90
    // 1.17), over the retained top-two-thirds-mean estimator. The 1.26x this
    // comment used to cite came from the superseded p99 estimator.
    // One resolver, shared with the measured side, so both columns of the
    // top-speed row are built from the same rating.
    const runSpeed = finite(resolveCharacterRunSpeed(character))
    const fieldCurve = runSpeed == null ? null : getFieldSpeed(runSpeed)
    const baserunCurve = runSpeed == null ? null : getBaserunSpeed(runSpeed)
    const catchRadii = getCharacterCatchMechanics(character)

    return [String(character.id), {
      fieldTopSpeedFps: fieldCurve ? fieldCurve.speedPerSecond * METRES_TO_FEET : null,
      baserunTopSpeedFps: baserunCurve ? baserunCurve.speedPerSecond * METRES_TO_FEET : null,
      baserunTopSpeedValidated: SPEED_CURVE_VALIDATION.baserunning.validated,
      // World units, glove-relative, straight off the revised workbook sheet.
      catchRadiusRegular: finite(catchRadii?.regular),
      catchRadiusDive: finite(catchRadii?.dive),
      catchRadiusHeight: finite(catchRadii?.height),
      catchRadiusFacingAway: finite(catchRadii?.facingAway),
      catchRadiusSafer: finite(catchRadii?.saferCatch),
      catchRadiusLineDriveDiveHeight: finite(catchRadii?.lineDriveDiveHeight),
      // Columns J and K. Neither is established as the jump reach -- J repeats
      // the facing-away radius in 94 of 101 profiles and sits below the
      // standing radius in 96, K sits above it in 76 -- so both are carried
      // under names that say so and neither is presented as "jump".
      catchColumnJ: finite(catchRadii?.jump),
      catchColumnK: finite(catchRadii?.unknownRegularLike),
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

  // ── Character mechanics against tracked performance ──────────────────────
  //
  // The only row on this table where the two sides are the SAME QUANTITY in
  // the same unit, so it carries a real difference as well as a percentile
  // one. `sameUnit` is what tells the table that.
  {
    key: 'fieldTopSpeed', label: 'Top Speed (fielding)', group: 'Fielding',
    mined: { field: 'fieldTopSpeedFps', scale: FEET_PER_SECOND_TO_MPH, digits: 2, unit: 'mph' },
    measured: {
      field: 'maxSpeedFps', scale: FEET_PER_SECOND_TO_MPH, samples: 'maxSpeedSamples', unit: 'mph', digits: 2,
      label: 'Game constant',
      // WHICH OBSERVATIONS THE DISPLAYED VALUE IS MADE OF. Every other row on
      // this table has one kind of sample. This one has three -- ordinary,
      // boosted, and matching neither curve row -- and the ORDINARY count
      // alone is the denominator of the number shown. Without these fields a
      // character seen only while boosted rendered as "no samples" with n=0,
      // which says nothing was observed when a dozen rows were and every one
      // of them was excluded on purpose.
      classification: {
        ordinarySamples: 'maxSpeedSamples',
        boostedSamples: 'maxSpeedBoostedSamples',
        unmatchedSamples: 'maxSpeedUnclassifiedSamples',
        observedSamples: 'maxSpeedObservedSamples',
        classified: 'maxSpeedClassified',
        boostedValue: 'maxSpeedBoostedFps',
        unverifiedValue: 'maxSpeedUnverifiedFps',
        distinctValues: 'maxSpeedDistinctValues',
      },
    },
    sameUnit: 'mph',
    note: 'Capacity, not effort: the workbook curve against the constant the '
      + 'fielder actor holds. The same on every play, so one observation pins '
      + 'it — n is how many ORDINARY observations carried it, not how much '
      + 'evidence it took. The difference beside it is not independent '
      + 'confirmation of the curve: a value is only called ordinary when it is '
      + 'already within 0.007 mph of this row, so it cannot come out much '
      + 'larger. What is independent is how much of the cast has any value '
      + 'inside that window — node scripts/audit_character_mechanics.mjs '
      + 'reports that count and its denominator.',
  },
  // THE TWO SIDES ARE NOT COMPARED. `compare: false` suppresses the delta: the
  // workbook radius is measured from the glove and the observation from the
  // fielder actor origin, so they are not the same quantity, and NO ranking
  // evidence is strong enough to stand in for one. The r = 0.73 that was once
  // cited for standing reach came from a one-off pass over the local archive,
  // is not reproducible from the database this page reads, and did not survive
  // at the other approaches -- dive reach ranked NEGATIVELY, r = -0.53.
  // Publishing a delta from that would read as agreement nobody has shown.
  {
    key: 'ordinaryReach', label: 'Standing Catch Reach', group: 'Fielding',
    mined: { field: 'catchRadiusRegular', digits: 3, unit: 'u' },
    measured: {
      field: 'ordinaryReachUnits', samples: 'ordinaryReachSamples',
      attempts: 'ordinaryReachAttempts', unit: 'u', digits: 2, label: 'Secured, 90th pct',
    },
    compare: false,
    note: 'Side by side, not a comparison. The workbook radius is glove-relative '
      + 'and the measurement runs from the fielder actor origin, so the two are '
      + 'not the same quantity and the gap between them is not meaningful. '
      + 'n counts secured catches; attempts include the ones that came up empty.',
  },
  {
    key: 'diveReach', label: 'Dive Reach', group: 'Fielding',
    mined: { field: 'catchRadiusDive', digits: 3, unit: 'u' },
    measured: {
      field: 'diveReachUnits', samples: 'diveReachSamples',
      attempts: 'diveReachAttempts', unit: 'u', digits: 2, label: 'Secured, 90th pct',
    },
    compare: false,
    note: 'Side by side, not a comparison. Across 13 characters the published '
      + 'radius and the observation did not agree even in rank, which is the '
      + 'strongest statement available about either row — no reach row here '
      + 'has established agreement with its published radius. How far a dive '
      + 'travels is mostly how far the ball was.',
  },
  {
    key: 'leapReach', label: 'Leap Reach', group: 'Fielding',
    measured: {
      field: 'leapReachUnits', samples: 'leapReachSamples',
      attempts: 'leapReachAttempts', unit: 'u', digits: 2, label: 'Secured, 90th pct',
    },
    compare: false,
    note: 'Measured only. No workbook column has been established as the leap '
      + 'reach, so there is nothing to show on the left.',
  },
  {
    key: 'catchHeight', label: 'Catch Height', group: 'Fielding',
    mined: { field: 'catchRadiusHeight', digits: 3, unit: 'u' },
    compare: false,
    note: 'Published value only. Measuring it needs the ball height above the '
      + 'glove, and the capture does not yet separate the glove from the '
      + 'fielder actor origin.',
  },
  {
    key: 'facingAwayReach', label: 'Facing-Away Reach', group: 'Fielding',
    mined: { field: 'catchRadiusFacingAway', digits: 3, unit: 'u' },
    compare: false,
    note: 'Published value only. Measuring it needs the direction the fielder '
      + 'is facing; the capture holds angular velocity and a steering target, '
      + 'and neither is an orientation.',
  },
  { key: 'hardestThrow', label: 'Hardest Throw', group: 'Fielding', measured: { field: 'hardestThrowMph', samples: 'throwSamples', unit: 'mph', digits: 1 } },
  { key: 'reaction', label: 'Reaction', group: 'Fielding', measured: { field: 'reactionSeconds', samples: 'reactionSamples', unit: 's', digits: 2, invert: true } },
  {
    key: 'jumpDistance', label: 'First-Step Distance', group: 'Fielding',
    measured: { field: 'jumpDistanceFeet', samples: 'jumpSamples', unit: 'ft', digits: 1 },
    // Renamed from "Jump Distance" on purpose. This is the Statcast Jump
    // quantity -- ground covered in a fixed window after pitch release -- and
    // the workbook's `jump` column is a catch RADIUS. Two different things,
    // and the old name invited them to be read as the same trait.
    note: 'Ground covered in the opening window after release, the Statcast '
      + 'Jump quantity. Not a catch radius and not comparable to one.',
  },
  { key: 'jumpBurst', label: 'Jump Burst', group: 'Fielding', measured: { field: 'jumpBurstFeet', samples: 'jumpSamples', unit: 'ft', digits: 1 } },
  { key: 'armValue', label: 'Arm Run Value', group: 'Fielding', measured: { field: 'armValue', samples: 'armOpportunities', unit: '', digits: 2 } },
  { key: 'armKills', label: 'Runners Thrown Out', group: 'Fielding', measured: { field: 'armKills', samples: 'armOpportunities', unit: '', digits: 0 } },
  { key: 'doublePlaysAdded', label: 'Double Plays Added', group: 'Fielding', measured: { field: 'doublePlaysAdded', samples: 'doublePlayOpportunities', unit: '', digits: 2 } },
  { key: 'positionDepth', label: 'Avg Position Depth', group: 'Fielding', measured: { field: 'averagePositionDepthFeet', samples: 'positioningSamples', unit: 'ft', digits: 1 } },

  // ── Running ──────────────────────────────────────────────────────────────
  {
    key: 'runSpeed', label: 'Run Speed', group: 'Running',
    mined: { field: 'runSpeed', digits: 0 },
    measured: { field: 'sprintSpeedFps', scale: FEET_PER_SECOND_TO_MPH, samples: 'speedSamples', unit: 'mph', digits: 1, label: 'Sprint Speed' },
  },
  { key: 'baserunning', label: 'Baserunning', group: 'Running', mined: { field: 'baserunning', digits: 1 } },
  {
    key: 'baserunTopSpeed', label: 'Top Speed (baserunning)', group: 'Running',
    mined: { field: 'baserunTopSpeedFps', scale: FEET_PER_SECOND_TO_MPH, digits: 2, unit: 'mph' },
    // Deliberately unpaired, and NOT because the measurement is poor. Measured
    // runner sprint tracks run_speed well (r = 0.87 over 71 characters,
    // scripts/verify_speed_against_attributes.mjs). What it does not do is land
    // on this curve's VALUES: it sits a consistent 1.14x above them, p10 1.12
    // to p90 1.17. Correlating with the curve's input axis is not the same as
    // measuring its output, and the fielding row above shows what agreement
    // actually looks like -- the constant lands on its curve to 0.0003 ft/s.
    compare: false,
    note: 'Published value only. Measured runner sprint tracks the run_speed '
      + 'rating closely, but sits a consistent 1.14x above this curve’s own '
      + 'values, so it measures something else. The offense actor holds no '
      + 'speed constant to check the curve against directly.',
  },
  { key: 'maxSprint', label: 'Max Sprint Speed', group: 'Running', measured: { field: 'maxSprintSpeedFps', scale: FEET_PER_SECOND_TO_MPH, samples: 'speedSamples', unit: 'mph', digits: 1 } },
  { key: 'homeToFirst', label: 'Home to First', group: 'Running', measured: { field: 'homeToFirstSeconds', samples: 'homeToFirstSamples', unit: 's', digits: 2, invert: true } },
  { key: 'ninetyFoot', label: '90-ft Split', group: 'Running', measured: { field: 'ninetyFootSplitSeconds', samples: 'homeToFirstSamples', unit: 's', digits: 2, invert: true } },
  { key: 'bolts', label: 'Bolts', group: 'Running', measured: { field: 'bolts', samples: 'speedSamples', unit: '', digits: 0 } },
]

// ─── How a measured value was classified before it was displayed ─────────────
//
// Only the fielding top-speed row uses this, and it exists because that row's
// absences are not one absence. "Never observed", "observed only while
// boosted", "observed and matching neither curve row" and "observed with no
// rating to check it against" are four different states with four different
// answers, and collapsing them into a dash or into "no samples" asserts the
// first one every time.
//
// `state` is what the page switches on. `excludedSamples` is everything
// observed that could not produce the displayed value, so a row can say how
// many observations it is NOT showing without the caller re-deriving it.
export function buildClassification(spec, measured) {
  const count = (key) => (key ? finite(measured[spec[key]]) ?? 0 : 0)
  const value = (key) => (key ? finite(measured[spec[key]]) : null)
  const classified = spec.classified ? measured[spec.classified] === true : true
  const ordinarySamples = count('ordinarySamples')
  const boostedSamples = count('boostedSamples')
  const unmatchedSamples = count('unmatchedSamples')
  const observedSamples = count('observedSamples')
  // WITHOUT A RATING NOTHING WAS CHECKED, so no observation counts as
  // ordinary however many there were. buildMeasuredIndex has already moved
  // the value out of `maxSpeedFps`; this keeps the arithmetic agreeing with
  // it rather than trusting two places to stay in step.
  const excludedSamples = classified
    ? Math.max(0, observedSamples - ordinarySamples)
    : observedSamples

  const state = !observedSamples ? 'none'
    : !classified ? 'unrated'
      : ordinarySamples > 0 ? 'ordinary'
        : (boostedSamples > 0 && unmatchedSamples > 0) ? 'boosted-and-unmatched'
          : boostedSamples > 0 ? 'boosted-only'
            : unmatchedSamples > 0 ? 'unmatched-only'
              // Observed, classified, and in none of the three buckets. Not a
              // state the aggregator can produce today; named rather than
              // silently folded into one of the others if it ever is.
              : 'unaccounted'

  return {
    state,
    classified,
    ordinarySamples,
    boostedSamples,
    unmatchedSamples,
    observedSamples,
    excludedSamples,
    boostedValue: value('boostedValue'),
    // The constant seen for a character with no rating. Offered for display
    // beside the state that says it was never checked -- never as the value.
    unverifiedValue: value('unverifiedValue'),
    distinctValues: count('distinctValues'),
  }
}

/**
 * The short text a page puts beside a classified measurement, and the longer
 * one it puts in the title.
 *
 * Here rather than in the component so the wording is testable without a
 * browser, and so the page cannot quietly invent a fifth state: every string a
 * reader can see for this row is produced by this function.
 *
 * Returns null when there is nothing extra to say -- every observation was
 * ordinary, or there were none at all.
 */
export function describeSpeedClassification(classification, { digits = 2, unit = 'ft/s', scale = 1 } = {}) {
  if (!classification || classification.state === 'none') return null
  const {
    state, ordinarySamples, boostedSamples, unmatchedSamples,
    observedSamples, excludedSamples, boostedValue, unverifiedValue,
  } = classification
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
  const fixed = (value) => (Number.isFinite(value) ? `${(value * scale).toFixed(digits)} ${unit}` : null)
  const boostedPart = `${plural(boostedSamples, 'observation')} at the boosted curve row`
    + (fixed(boostedValue) ? ` (${fixed(boostedValue)})` : '')
  const unmatchedPart = `${plural(unmatchedSamples, 'observation')} matching neither curve row`

  if (state === 'unrated') {
    return {
      label: `no rating · ${observedSamples}`,
      detail: `No run_speed for this character, so ${plural(observedSamples, 'observation')} `
        + 'could not be checked against a curve row at all. '
        + (fixed(unverifiedValue) ? `The value seen was ${fixed(unverifiedValue)}. ` : '')
        + 'It is not shown as the ordinary constant because nothing has established that it is one.',
    }
  }
  if (state === 'boosted-only') {
    return {
      label: `boosted only · ${boostedSamples}`,
      detail: `Every observation of this character -- ${boostedPart} -- was above what their `
        + 'rating allows, so none of them is their ordinary top speed. What puts a fielder in '
        + 'that state is not established; see scripts/audit_character_mechanics.mjs.',
    }
  }
  if (state === 'unmatched-only') {
    return {
      label: `matches neither row · ${unmatchedSamples}`,
      detail: `${unmatchedPart}. Left unassigned rather than rounded to the nearer one: a `
        + 'constant off both rows usually means the rating this was checked against is wrong.',
    }
  }
  if (state === 'boosted-and-unmatched') {
    return {
      label: `no ordinary observation · ${excludedSamples}`,
      detail: `${boostedPart}; ${unmatchedPart}. Neither can stand in for the ordinary constant.`,
    }
  }
  if (state === 'unaccounted') {
    return {
      label: `unaccounted · ${excludedSamples}`,
      detail: `${plural(excludedSamples, 'observation')} was neither ordinary, boosted nor `
        + 'unmatched, which the aggregator is not expected to produce. Reported rather than hidden.',
    }
  }
  // state === 'ordinary'. The value is shown; this only says what is not in it.
  if (!excludedSamples) return null
  const parts = [boostedSamples ? boostedPart : null, unmatchedSamples ? unmatchedPart : null]
    .filter(Boolean)
  return {
    label: `${excludedSamples} excluded`,
    detail: `The value is from ${plural(ordinarySamples, 'ordinary observation')} of `
      + `${observedSamples}. Excluded: ${parts.join('; ')}.`,
  }
}

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

    // The count is reported even when the value is suppressed. "Three dives,
    // and three is not enough" is a different state from "never dived", and a
    // null here collapsed the two -- which is exactly the distinction the
    // reach rows exist to make.
    const samples = (row.measured?.samples && measured)
      ? finite(measured[row.measured.samples]) ?? 0
      : null
    // The wider denominator, where a row has one: every attempt, including the
    // ones that produced no measurement. "Three dives, none held" and "never
    // dived" are different states and only this tells them apart.
    const attempts = (row.measured?.attempts && measured)
      ? finite(measured[row.measured.attempts]) ?? 0
      : null

    // ── Observations the displayed value is NOT made of ────────────────────
    //
    // The top-speed row is the only one with more than one kind of sample. An
    // observation is ordinary, boosted, or matching neither curve row, and
    // only the ordinary ones can produce the number in the Measured column --
    // so `samples` above counts those alone and this says what else was seen.
    // A character observed fourteen times, all of them boosted, has an empty
    // Measured column and fourteen observations, and both facts have to reach
    // the page or it reports "no samples".
    const classification = (row.measured?.classification && measured)
      ? buildClassification(row.measured.classification, measured)
      : null
    const excluded = classification ? classification.excludedSamples : 0

    return {
      key: row.key,
      label: row.label,
      group: row.group,
      minedValue,
      minedPercentile: minedPct,
      minedDigits: row.mined?.digits ?? 0,
      minedUnit: row.mined?.unit ?? '',
      measuredValue,
      measuredPercentile: measuredPct,
      measuredDigits: row.measured?.digits ?? 1,
      measuredUnit: row.measured?.unit ?? '',
      measuredScale: row.measured?.scale ?? 1,
      measuredLabel: row.measured?.label || null,
      samples,
      attempts,
      // Observations that exist and could not produce the displayed value.
      // Distinct from `attempts`, which counts windows the character was TRIED
      // in; these were measured successfully and then excluded by what they
      // turned out to be.
      excluded,
      classification,
      // What this row can and cannot be read as. `note` is the caveat the
      // number cannot carry on its own; a row that has one is a row where
      // reading the two columns as the same measurement would be wrong.
      note: row.note || null,
      // WHETHER THE TWO SIDES MAY BE COMPARED AT ALL. `compare: false` on the
      // definition means no -- the columns are a published value and an
      // observation of something related but not identical, and a delta
      // between them would assert an equivalence nobody has established.
      comparable: row.compare !== false,
      // Positive: the tracker measured them ABOVE what the game's own attribute implies.
      delta: (row.compare !== false && minedPct != null && measuredPct != null)
        ? measuredPct - minedPct
        : null,
      // Only where the two sides are genuinely the same quantity in the same
      // unit. Everywhere else the percentile delta above is the only honest
      // comparison, because a raw subtraction of a 0-100 rating and a speed
      // means nothing -- see the header.
      sameUnit: row.sameUnit || null,
      directDelta: (row.sameUnit && minedValue != null && measuredValue != null)
        ? measuredValue - minedValue
        : null,
      // Three distinct absences, because they call for three distinct answers:
      //
      //   awaitingSamples      nothing qualifying has been observed yet.
      //   attemptedNoneHeld    this was tried and never completed, so there is
      //                        no secured separation to quantile. Not "too
      //                        few" -- the attempts are there, the catches
      //                        are not.
      //   insufficientSamples  qualifying observations exist and fall short of
      //                        the display threshold; the count is shown.
      //
      // None of them means the trait can never be measured. A row with no
      // measured side at all simply renders a dash and says why in its note.
      awaitingSamples: Boolean(
        row.measured && measuredValue == null && !samples && !attempts && !excluded,
      ),
      attemptedNoneHeld: Boolean(
        row.measured && measuredValue == null && !samples && attempts > 0,
      ),
      insufficientSamples: Boolean(row.measured && measuredValue == null && samples > 0),
      //   excludedOnly  observations exist and every one of them was excluded
      //                 from the displayed value. `classification.state` names
      //                 which exclusion it was; this only says the row is not
      //                 empty, so it must not render as "no samples".
      excludedOnly: Boolean(
        row.measured && measuredValue == null && !samples && !attempts && excluded > 0,
      ),
    }
  })
}
