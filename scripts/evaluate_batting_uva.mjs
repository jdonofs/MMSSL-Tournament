import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildExpectedOutcomeModel, EXPECTED_OUTCOME_MODEL_VERSION } from '../src/utils/expectedStats.js'
import { loadOfficialArchiveGames, ROOT } from './batting_uva_archive.mjs'

export const BATTING_UVA_EVALUATION_VERSION = 'batting-uva-feasibility-v1'
export const OUTPUT = path.join(ROOT, 'data', 'calibration', 'batting-uva-evaluation-v1.json')

const HIT_RESULTS = new Set(['1B', '2B', '3B', 'HR', 'IPHR'])
const WOBA = Object.freeze({ '1B': 0.89, '2B': 1.27, '3B': 1.62, HR: 2.10, IPHR: 2.10 })
const FORBIDDEN_FEATURES = new Set([
  'result', 'contact', 'outcome', 'rbi', 'runs', 'outs_on_play', 'run_scored',
  'is_hit', 'actual_woba', 'batted_ball_class',
])

export const MODEL_FEATURES = Object.freeze({
  decision: Object.freeze([
    'count', 'pitch_zone', 'batter_character', 'pitcher_character', 'park',
    'player', 'opponent', 'pitch_type', 'plate_x', 'plate_y', 'pitch_speed',
    'pitch_horizontal', 'pitch_vertical',
  ]),
  swingMode: Object.freeze([
    'count', 'pitch_zone', 'batter_character', 'pitcher_character', 'park',
    'player', 'opponent', 'pitch_type', 'plate_x', 'plate_y', 'pitch_speed',
    'pitch_horizontal', 'pitch_vertical',
  ]),
  contact: Object.freeze([
    'count', 'pitch_zone', 'batter_character', 'pitcher_character', 'park',
    'player', 'opponent', 'pitch_type', 'swing_mode', 'plate_x', 'plate_y',
    'pitch_speed', 'pitch_horizontal', 'pitch_vertical',
  ]),
  chargeTiming: Object.freeze([
    'count', 'pitch_zone', 'batter_character', 'pitcher_character', 'park',
    'player', 'opponent', 'pitch_type', 'swing_mode', 'plate_x', 'plate_y',
    'pitch_speed', 'pitch_horizontal', 'pitch_vertical',
    'charge_frames', 'release_timing',
  ]),
})

export function assertLeakageSafeFeatures(featureNames) {
  const leaked = featureNames.filter((name) => FORBIDDEN_FEATURES.has(name))
  if (leaked.length) throw new Error(`Target leakage feature(s): ${leaked.join(', ')}`)
  return true
}

for (const features of Object.values(MODEL_FEATURES)) assertLeakageSafeFeatures(features)

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function round(value, digits = 6) {
  if (value == null || !Number.isFinite(Number(value))) return null
  const factor = 10 ** digits
  return Math.round(Number(value) * factor) / factor
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function variance(values) {
  if (values.length < 2) return null
  const avg = mean(values)
  return values.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / values.length
}

function sigmoid(value) {
  if (value >= 0) return 1 / (1 + Math.exp(-value))
  const exp = Math.exp(value)
  return exp / (1 + exp)
}

function clampProbability(value) {
  return Math.min(1 - 1e-9, Math.max(1e-9, value))
}

function categorical(object, name, value) {
  if (value == null || value === '') return
  object[`${name}=${String(value)}`] = 1
}

function numeric(object, name, value, scale) {
  const number = finite(value)
  if (number == null) return
  object[name] = number / scale
}

export function featureVector(row, featureNames) {
  assertLeakageSafeFeatures(featureNames)
  const vector = {}
  for (const feature of featureNames) {
    if (feature === 'count') categorical(vector, feature, `${row.ballsBefore}-${row.strikesBefore}`)
    else if (feature === 'pitch_zone') categorical(vector, feature, row.pitchZone)
    else if (feature === 'batter_character') categorical(vector, feature, row.batterCharacterId)
    else if (feature === 'pitcher_character') categorical(vector, feature, row.pitcherCharacterId)
    else if (feature === 'park') categorical(vector, feature, row.park)
    else if (feature === 'player') categorical(vector, feature, row.playerId)
    else if (feature === 'opponent') categorical(vector, feature, row.pitcherPlayerId)
    else if (feature === 'pitch_type') categorical(vector, feature, row.pitchType)
    else if (feature === 'swing_mode') categorical(vector, feature, row.swingMode)
    else if (feature === 'plate_x') numeric(vector, feature, row.plateX, 1)
    else if (feature === 'plate_y') numeric(vector, feature, row.plateY, 2)
    else if (feature === 'pitch_speed') numeric(vector, feature, row.pitchSpeedMph, 50)
    else if (feature === 'pitch_horizontal') numeric(vector, feature, row.pitchHorizontalDelta, 3)
    else if (feature === 'pitch_vertical') numeric(vector, feature, row.pitchVerticalDelta, 3)
    else if (feature === 'charge_frames') numeric(vector, feature, row.chargeFrames, 60)
    else if (feature === 'release_timing') numeric(vector, feature, row.releaseTimingFrames, 60)
    else throw new Error(`Unknown model feature: ${feature}`)
  }
  return vector
}

function trainLogistic(rows, labelKey, featureNames, { epochs = 450, learningRate = 0.25, l2 = 0.8 } = {}) {
  const examples = rows.map((row) => ({ row, y: row[labelKey] ? 1 : 0, x: featureVector(row, featureNames) }))
  const prevalence = (examples.reduce((sum, row) => sum + row.y, 0) + 1) / (examples.length + 2)
  let intercept = Math.log(prevalence / (1 - prevalence))
  const weights = new Map()
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    let interceptGradient = 0
    const gradients = new Map()
    for (const example of examples) {
      let score = intercept
      for (const [feature, value] of Object.entries(example.x)) score += (weights.get(feature) || 0) * value
      const error = sigmoid(score) - example.y
      interceptGradient += error
      for (const [feature, value] of Object.entries(example.x)) {
        gradients.set(feature, (gradients.get(feature) || 0) + error * value)
      }
    }
    const n = Math.max(1, examples.length)
    intercept -= learningRate * interceptGradient / n
    for (const [feature, gradient] of gradients) {
      const current = weights.get(feature) || 0
      weights.set(feature, current - learningRate * ((gradient / n) + (l2 * current / n)))
    }
  }
  return {
    prevalence,
    predict(row) {
      const vector = featureVector(row, featureNames)
      let score = intercept
      for (const [feature, value] of Object.entries(vector)) score += (weights.get(feature) || 0) * value
      return clampProbability(sigmoid(score))
    },
  }
}

function auc(predictions) {
  const positives = predictions.filter((row) => row.actual === 1)
  const negatives = predictions.filter((row) => row.actual === 0)
  if (!positives.length || !negatives.length) return null
  let wins = 0
  for (const positive of positives) for (const negative of negatives) {
    if (positive.predicted > negative.predicted) wins += 1
    else if (positive.predicted === negative.predicted) wins += 0.5
  }
  return wins / (positives.length * negatives.length)
}

function binaryMetrics(predictions, probabilityKey = 'predicted') {
  if (!predictions.length) return { n: 0, positives: 0, rate: null, brier: null, logLoss: null, accuracy: null, auc: null }
  const metrics = predictions.map((row) => ({ actual: row.actual, predicted: clampProbability(row[probabilityKey]) }))
  return {
    n: metrics.length,
    positives: metrics.reduce((sum, row) => sum + row.actual, 0),
    rate: round(mean(metrics.map((row) => row.actual))),
    brier: round(mean(metrics.map((row) => (row.predicted - row.actual) ** 2))),
    logLoss: round(mean(metrics.map((row) => -(
      row.actual * Math.log(row.predicted) + (1 - row.actual) * Math.log(1 - row.predicted)
    )))),
    accuracy: round(mean(metrics.map((row) => Number((row.predicted >= 0.5) === Boolean(row.actual))))),
    auc: round(auc(metrics)),
  }
}

function calibration(predictions) {
  const bins = Array.from({ length: 5 }, (_, index) => ({ lower: index / 5, upper: (index + 1) / 5, rows: [] }))
  for (const row of predictions) bins[Math.min(4, Math.floor(row.predicted * 5))].rows.push(row)
  return bins.map((bin) => ({
    lower: bin.lower,
    upper: bin.upper,
    n: bin.rows.length,
    meanPrediction: round(mean(bin.rows.map((row) => row.predicted))),
    observedRate: round(mean(bin.rows.map((row) => row.actual))),
  }))
}

export function evaluateGroupedBinary(rows, { labelKey, featureNames }) {
  const usable = rows.filter((row) => typeof row[labelKey] === 'boolean')
  const games = [...new Set(usable.map((row) => row.gameId))].sort((a, b) => Number(a) - Number(b))
  const predictions = []
  const folds = []
  for (const heldOutGame of games) {
    const training = usable.filter((row) => row.gameId !== heldOutGame)
    const testing = usable.filter((row) => row.gameId === heldOutGame)
    if (!training.length || !testing.length) continue
    const model = trainLogistic(training, labelKey, featureNames)
    const foldPredictions = testing.map((row) => ({
      gameId: row.gameId,
      playerId: row.playerId,
      batterCharacterId: row.batterCharacterId,
      pitcherCharacterId: row.pitcherCharacterId,
      park: row.park,
      swingMode: row.swingMode,
      contactResult: row.contact === true ? 'contact' : row.contact === false ? 'no_contact' : null,
      controllerSide: row.controllerSide,
      actual: row[labelKey] ? 1 : 0,
      predicted: model.predict(row),
      baseline: model.prevalence,
    }))
    predictions.push(...foldPredictions)
    folds.push({
      heldOutGame,
      trainN: training.length,
      test: binaryMetrics(foldPredictions),
      baseline: binaryMetrics(foldPredictions, 'baseline'),
    })
  }
  return {
    split: 'leave_one_whole_game_out',
    games: games.length,
    features: featureNames,
    metrics: binaryMetrics(predictions),
    baselineMetrics: binaryMetrics(predictions, 'baseline'),
    calibration: calibration(predictions),
    folds,
    predictions,
  }
}

function summarizeSlices(predictions, key) {
  const groups = new Map()
  for (const row of predictions) {
    const value = row[key] ?? 'unobserved'
    if (!groups.has(String(value))) groups.set(String(value), [])
    groups.get(String(value)).push(row)
  }
  return Object.fromEntries([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([value, rows]) => [
    value,
    binaryMetrics(rows),
  ]))
}

function contactPhysics(play) {
  const features = play?.preoutcome_flight?.features
  const horizontal = finite(features?.initial_horizontal_speed_ups)
  const vertical = finite(features?.initial_vertical_speed_ups)
  if (horizontal == null || vertical == null || horizontal <= 0) return null
  return {
    exit_velocity_mph: Math.hypot(horizontal, vertical) * 2.2369362921,
    launch_angle_deg: Math.atan2(vertical, horizontal) * 180 / Math.PI,
  }
}

function evaluationRows(games) {
  return games.flatMap((game) => game.alignedRows.map(({ raw, canonical, event, play }) => ({
    gameId: game.gameId,
    session: game.session,
    park: game.park,
    paId: event.paId,
    paNumber: event.paNumber,
    pitchNumberPa: raw.pitch_in_pa,
    playerId: event.pa.player_id ?? null,
    batterCharacterId: event.pa.character_id ?? null,
    batterName: canonical.batter_id ?? raw.batter ?? null,
    pitcherPlayerId: event.pa.pitcher_player_id ?? null,
    pitcherCharacterId: event.pa.pitcher_id ?? null,
    pitcherName: canonical.pitcher_id ?? raw.pitcher ?? null,
    controllerSide: null,
    ballsBefore: finite(raw.balls_before ?? canonical.count_balls_before),
    strikesBefore: finite(raw.strikes_before ?? canonical.count_strikes_before),
    pitchZone: raw.pitch_zone ?? null,
    plateX: finite(raw.plate_x_units),
    plateY: finite(raw.plate_y_units),
    plateZ: finite(raw.plate_z_units),
    isChase: typeof raw.is_chase === 'boolean' ? raw.is_chase : null,
    pitchType: canonical.pitch_type ?? null,
    pitchSpeedMph: finite(canonical.pitch_speed_mph),
    pitchHorizontalDelta: finite(canonical.pitch_horizontal_delta_units),
    pitchVerticalDelta: finite(canonical.pitch_vertical_delta_units),
    offer: raw.offer ?? null,
    offered: raw.offer === 'swing' || raw.offer === 'bunt',
    swingMode: raw.swing_mode ?? null,
    contact: typeof raw.contact === 'boolean' ? raw.contact : null,
    chargeFrames: finite(raw.swing_charge_frames),
    releaseTimingFrames: finite(raw.swing_charge_release_timing_frames),
    canonicalPitchResult: canonical.result ?? null,
    paResult: event.pa.result ?? null,
    paIsError: event.pa.is_error === true,
    play,
  })))
}

function contactQualityEvaluation(rows) {
  const samples = rows.filter((row) => (
    row.contact === true && row.canonicalPitchResult === 'in_play' && row.swingMode !== 'star'
  )).map((row) => {
    const physics = contactPhysics(row.play)
    if (!physics) return null
    return {
      id: `${row.gameId}:${row.paId}`,
      game_id: row.gameId,
      competition_type: 'season',
      result: row.paResult,
      is_error: row.paIsError,
      star_hit_used: false,
      ...physics,
      playerId: row.playerId,
      batterCharacterId: row.batterCharacterId,
      pitcherCharacterId: row.pitcherCharacterId,
      park: row.park,
      swingMode: row.swingMode,
    }
  }).filter(Boolean)
  const model = buildExpectedOutcomeModel(samples)
  const predictions = samples.map((sample) => {
    const estimate = model.estimatePa(sample)
    if (!estimate) return null
    const actualHit = HIT_RESULTS.has(sample.result) && !sample.is_error ? 1 : 0
    const actualWoba = actualHit ? (WOBA[sample.result] || 0) : 0
    return {
      gameId: String(sample.game_id),
      playerId: sample.playerId,
      batterCharacterId: sample.batterCharacterId,
      pitcherCharacterId: sample.pitcherCharacterId,
      park: sample.park,
      swingMode: sample.swingMode,
      actual: actualHit,
      predicted: estimate.xHitProb,
      actualWoba,
      predictedWoba: estimate.xWobaValue,
      residualWoba: actualWoba - estimate.xWobaValue,
    }
  }).filter(Boolean)
  const byGame = [...new Set(predictions.map((row) => row.gameId))].sort((a, b) => Number(a) - Number(b)).map((gameId) => {
    const fold = predictions.filter((row) => row.gameId === gameId)
    return {
      heldOutGame: gameId,
      n: fold.length,
      hitProbability: binaryMetrics(fold),
      wobaMae: round(mean(fold.map((row) => Math.abs(row.residualWoba)))),
      wobaRmse: round(Math.sqrt(mean(fold.map((row) => row.residualWoba ** 2)))),
    }
  })
  return {
    modelVersion: EXPECTED_OUTCOME_MODEL_VERSION,
    split: 'leave_one_whole_game_out',
    predictors: ['measured post-contact exit velocity', 'measured post-contact launch angle'],
    realizedOutcomeIsInput: false,
    samples: samples.length,
    evaluated: predictions.length,
    hitProbability: binaryMetrics(predictions),
    wobaMae: round(mean(predictions.map((row) => Math.abs(row.residualWoba)))),
    wobaRmse: round(Math.sqrt(mean(predictions.map((row) => row.residualWoba ** 2))), 6),
    residualWobaVariance: round(variance(predictions.map((row) => row.residualWoba))),
    folds: byGame,
    slices: {
      player: summarizeSlices(predictions, 'playerId'),
      batterCharacter: summarizeSlices(predictions, 'batterCharacterId'),
      pitcherCharacter: summarizeSlices(predictions, 'pitcherCharacterId'),
      park: summarizeSlices(predictions, 'park'),
      swingMode: summarizeSlices(predictions, 'swingMode'),
    },
  }
}

function crossoverAudit(rows) {
  const pairs = new Map()
  const playerChars = new Map()
  const charPlayers = new Map()
  const playerGames = new Map()
  const parkGames = new Map()
  const add = (map, key, value) => {
    if (key == null || value == null) return
    if (!map.has(String(key))) map.set(String(key), new Set())
    map.get(String(key)).add(String(value))
  }
  for (const row of rows) {
    const pair = `${row.playerId ?? 'unknown'}:${row.batterCharacterId ?? 'unknown'}`
    if (!pairs.has(pair)) pairs.set(pair, { playerId: row.playerId, characterId: row.batterCharacterId, pitches: 0, games: new Set() })
    pairs.get(pair).pitches += 1
    pairs.get(pair).games.add(row.gameId)
    add(playerChars, row.playerId, row.batterCharacterId)
    add(charPlayers, row.batterCharacterId, row.playerId)
    add(playerGames, row.playerId, row.gameId)
    add(parkGames, row.park, row.gameId)
  }
  const pairCells = [...pairs.values()].map((row) => ({ ...row, games: row.games.size }))
  return {
    players: playerChars.size,
    batterCharacters: charPlayers.size,
    playerCharacterCells: pairCells.length,
    sparseCellsOneGameOrFewerThan20Pitches: pairCells.filter((row) => row.games <= 1 || row.pitches < 20).length,
    playersWithOneCharacter: [...playerChars].filter(([, values]) => values.size === 1).map(([key]) => key),
    charactersWithOnePlayer: [...charPlayers].filter(([, values]) => values.size === 1).map(([key]) => key),
    gamesPerPlayer: Object.fromEntries([...playerGames].map(([key, values]) => [key, values.size])),
    gamesPerPark: Object.fromEntries([...parkGames].map(([key, values]) => [key, values.size])),
    cells: pairCells.sort((a, b) => b.pitches - a.pitches),
  }
}

function compactEvaluation(evaluation) {
  const { predictions, ...rest } = evaluation
  return {
    ...rest,
    slices: {
      player: summarizeSlices(predictions, 'playerId'),
      batterCharacter: summarizeSlices(predictions, 'batterCharacterId'),
      pitcherCharacter: summarizeSlices(predictions, 'pitcherCharacterId'),
      park: summarizeSlices(predictions, 'park'),
      swingMode: summarizeSlices(predictions, 'swingMode'),
      controllerSide: summarizeSlices(predictions, 'controllerSide'),
      contactResult: summarizeSlices(predictions, 'contactResult'),
    },
  }
}

export function buildBattingUvaEvaluation() {
  const games = loadOfficialArchiveGames()
  const rows = evaluationRows(games)
  const decision = evaluateGroupedBinary(rows, {
    labelKey: 'offered', featureNames: MODEL_FEATURES.decision,
  })
  const ordinary = rows.filter((row) => row.swingMode === 'slap' || row.swingMode === 'charge')
    .map((row) => ({ ...row, choseCharge: row.swingMode === 'charge' }))
  const swingMode = evaluateGroupedBinary(ordinary, {
    labelKey: 'choseCharge', featureNames: MODEL_FEATURES.swingMode,
  })
  const swings = rows.filter((row) => row.offered && typeof row.contact === 'boolean')
  const contact = evaluateGroupedBinary(swings, {
    labelKey: 'contact', featureNames: MODEL_FEATURES.contact,
  })
  const charged = rows.filter((row) => (
    row.swingMode === 'charge' && typeof row.contact === 'boolean'
    && row.chargeFrames != null && row.releaseTimingFrames != null
  ))
  const chargeContext = evaluateGroupedBinary(charged, {
    labelKey: 'contact', featureNames: MODEL_FEATURES.contact,
  })
  const chargeTiming = evaluateGroupedBinary(charged, {
    labelKey: 'contact', featureNames: MODEL_FEATURES.chargeTiming,
  })
  const quality = contactQualityEvaluation(rows)
  const starSwings = rows.filter((row) => row.swingMode === 'star').length
  const starAvailabilityObserved = rows.filter((row) => (
    row.rawStarMeterBefore != null
  )).length
  return {
    version: BATTING_UVA_EVALUATION_VERSION,
    generatedAt: new Date().toISOString(),
    productionScoringActivated: false,
    splitPolicy: 'Every prediction is out of sample by entire game. No random pitch split is used.',
    leakagePolicy: {
      realizedHitOutRbiUsedAsPreContactInput: false,
      derivedSwingModeUsedToValidateChargeDetector: false,
      sameGameInTrainingAndTest: false,
      missingEvidenceImputedAsZero: false,
    },
    cohort: {
      games: games.length,
      sessions: games.map((game) => game.session),
      archivePitchesInSelectedSessions: games.reduce((sum, game) => sum + game.pitches.length, 0),
      canonicalAlignedPitches: rows.length,
      players: new Set(rows.map((row) => row.playerId).filter(Boolean)).size,
      batterCharacters: new Set(rows.map((row) => row.batterCharacterId).filter((value) => value != null)).size,
      parks: new Set(rows.map((row) => row.park).filter(Boolean)).size,
      offers: rows.filter((row) => row.offered).length,
      takes: rows.filter((row) => !row.offered).length,
      ordinarySwings: ordinary.length,
      slapSwings: ordinary.filter((row) => !row.choseCharge).length,
      chargeSwings: ordinary.filter((row) => row.choseCharge).length,
      contactModelSwings: swings.length,
      chargedTimingSamples: charged.length,
      starSwings,
      starAvailabilityObserved,
      contactQualitySamples: quality.samples,
      controllerSideObserved: rows.filter((row) => row.controllerSide != null).length,
    },
    evaluations: {
      swingTakeDecisionBehavior: compactEvaluation(decision),
      slapChargeChoiceBehavior: compactEvaluation(swingMode),
      contactProbability: compactEvaluation(contact),
      chargeContactContextOnly: compactEvaluation(chargeContext),
      chargeContactWithTiming: compactEvaluation(chargeTiming),
      contactQuality: quality,
    },
    chargeTimingComparison: {
      contextOnlyBrier: chargeContext.metrics.brier,
      withTimingBrier: chargeTiming.metrics.brier,
      brierImprovement: round(
        chargeContext.metrics.brier == null || chargeTiming.metrics.brier == null
          ? null : chargeContext.metrics.brier - chargeTiming.metrics.brier,
      ),
      interpretation: 'Association only. The charge counter is not an independent batter power/contact timing marker.',
    },
    confounding: crossoverAudit(rows),
    components: {
      swingDecisionRuns: {
        status: 'not_publishable',
        observed: ['swing/take/bunt offer', 'count', 'plate endpoint', 'conservative zone/chase state'],
        blocker: 'Behavior can be predicted out of game, but the archive does not identify counterfactual value of the unchosen action.',
      },
      slapChargeChoice: {
        status: 'provisional_behavior_only',
        blocker: 'Choice is observed, but choice value is confounded with player, character, opponent, and pitch quality.',
      },
      contactExecutionRuns: {
        status: 'not_publishable',
        blocker: 'OOF contact and contact-quality checks exist, but the cohort is too small and crossed too sparsely for player-minus-character run attribution.',
      },
      powerChargeTimingRuns: {
        status: 'not_publishable',
        blocker: 'Charge duration/release timing comes from the same charge counter; no independent power/contact timing marker exists.',
      },
      starSwingDecisionRuns: {
        status: 'not_publishable',
        blocker: 'Star swings are observed, but star availability and shared-resource opportunity cost are not observed in these official games.',
      },
      automaticCharacterContribution: {
        status: 'unidentified',
        blocker: 'Character, automatic animation/route behavior, and player are not sufficiently crossed to separate reliably.',
      },
      residualOutcomeVariance: {
        status: 'descriptive_only',
        observedWobaResidualVariance: quality.residualWobaVariance,
        blocker: 'Residual mixes defense, park interactions, automatic behavior, model error, and luck.',
      },
      totalBattingUva: {
        status: 'not_publishable',
        blocker: 'Required component run values are not independently identified or adequately calibrated.',
      },
    },
    unobservedInputs: [
      'pitch charge input and duration',
      'intended pitch aim before movement',
      'runner and fielder shake effort',
      'missed dive/jump/Buddy-action button attempts without animation/contact',
      'independent batter power/contact timing beyond the charge counter',
      'controller side in the official-game cohort',
      'star resource availability before each official pitch',
    ],
  }
}

export function writeBattingUvaEvaluation() {
  const report = buildBattingUvaEvaluation()
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true })
  fs.writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`)
  return report
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  const report = writeBattingUvaEvaluation()
  console.log(`Wrote ${path.relative(ROOT, OUTPUT)}`)
  console.log(JSON.stringify({
    games: report.cohort.games,
    alignedPitches: report.cohort.canonicalAlignedPitches,
    offers: report.cohort.offers,
    takes: report.cohort.takes,
    ordinarySwings: report.cohort.ordinarySwings,
    chargeTimingSamples: report.cohort.chargedTimingSamples,
    contactQualitySamples: report.cohort.contactQualitySamples,
    contactBrier: report.evaluations.contactProbability.metrics.brier,
    contactQualityWobaMae: report.evaluations.contactQuality.wobaMae,
    totalBattingUva: report.components.totalBattingUva.status,
  }, null, 2))
}

