import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { classifyFieldingAction, classifyPitchInput, classifySwingMode, USER_VALUE_VERSION } from '../src/utils/userValue.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TRACKING = path.join(ROOT, 'data', 'player_tracking')
const BRIDGE = path.join(ROOT, 'data', 'tracker_bridge_state')
const OUTPUT = path.join(ROOT, 'data', 'calibration', 'user-value-audit-v1.json')
const TEST_GAME_IDS = new Set(['2946', '2947', '2948'])

const fresh = () => ({
  files: 0,
  records: 0,
  batting: {
    pitches: 0, swings: 0, takes: 0, bunts: 0, contacts: 0, misses: 0,
    starSwings: 0, ordinarySwingsWithoutChargeState: 0, explicitSlap: 0, explicitCharge: 0,
    chargeDurationObserved: 0, chargeReleaseTimingObserved: 0, swingOnsetObserved: 0,
  },
  pitching: {
    classifiedPitches: 0, starPitches: 0, changeups: 0, pitchChargeObserved: 0,
    aimEndpointObserved: 0, types: {}, measuredVelocity: 0,
    starMeterObserved: 0, starMeterSpendObserved: 0,
  },
  baserunning: { runnerSegments: 0, speedMeasured: 0, shakeInputObserved: 0, discretionaryDecisionObserved: 0 },
  fielding: {
    fielderRoutes: 0, speedMeasured: 0, shakeInputObserved: 0, events: 0,
    dives: 0, jumps: 0, buddyJumps: 0, buddyAttacks: 0, buddyThrows: 0, ordinaryEvents: 0,
  },
})

function increment(map, key) {
  const clean = String(key ?? 'unresolved')
  map[clean] = (map[clean] || 0) + 1
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

async function eachJsonLine(file, visit) {
  const stream = fs.createReadStream(file, { encoding: 'utf8' })
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let count = 0
  for await (const line of lines) {
    if (!line.trim()) continue
    visit(JSON.parse(line))
    count += 1
  }
  return count
}

function observePitch(summary, pitch) {
  summary.batting.pitches += 1
  const resolvedOffer = pitch.offer || (pitch.swing_shown === true || Number(pitch.swing_frames) > 0 ? 'swing' : 'take')
  if (resolvedOffer === 'swing' || resolvedOffer === 'bunt') summary.batting.swings += 1
  else summary.batting.takes += 1
  if (resolvedOffer === 'bunt') summary.batting.bunts += 1
  if (pitch.contact === true || pitch.outcome === 'contact') summary.batting.contacts += 1
  if ((pitch.offer === 'swing' || Number(pitch.swing_frames) > 0) && pitch.contact === false) summary.batting.misses += 1
  const mode = classifySwingMode(pitch)
  if (mode.mode === 'ordinary_unknown') summary.batting.ordinarySwingsWithoutChargeState += 1
  if (mode.mode === 'slap') summary.batting.explicitSlap += 1
  if (mode.mode === 'charge') summary.batting.explicitCharge += 1
  if (pitch.swing_charge_frames != null) summary.batting.chargeDurationObserved += 1
  if (pitch.swing_charge_release_timing_frames != null) summary.batting.chargeReleaseTimingObserved += 1
  if (pitch.swing_start_timer != null) summary.batting.swingOnsetObserved += 1
  if (pitch.plate_x_units != null && pitch.plate_z_units != null) summary.pitching.aimEndpointObserved += 1
  const pitchInput = classifyPitchInput(pitch)
  if (pitchInput.type === 'star') summary.pitching.starPitches += 1
  if (pitchInput.type === 'changeup') summary.pitching.changeups += 1
  if (pitch.fielding_star_meter_spent != null) summary.pitching.starMeterObserved += 1
  if (Number(pitch.fielding_star_meter_spent) > 0) summary.pitching.starMeterSpendObserved += 1
}

function observePlay(summary, play) {
  const mode = classifySwingMode(play)
  if (mode.mode === 'star') summary.batting.starSwings += 1
  if (mode.mode === 'slap') summary.batting.explicitSlap += 1
  if (mode.mode === 'charge') summary.batting.explicitCharge += 1

  for (const runner of Object.values(play.runners || {})) {
    summary.baserunning.runnerSegments += 1
    if (Number.isFinite(Number(runner?.sprint_speed_ups))) summary.baserunning.speedMeasured += 1
    if (runner?.shake_input === true || Number.isFinite(Number(runner?.shake_frames))) summary.baserunning.shakeInputObserved += 1
  }
  for (const fielder of Object.values(play.fielders || {})) {
    summary.fielding.fielderRoutes += 1
    if (Number.isFinite(Number(fielder?.sprint_speed_ups))) summary.fielding.speedMeasured += 1
    if (fielder?.shake_input === true || Number.isFinite(Number(fielder?.shake_frames))) summary.fielding.shakeInputObserved += 1
  }
  let eventBuddyJumps = 0
  let eventBuddyAttacks = 0
  for (const event of play.fielding_events || []) {
    summary.fielding.events += 1
    const action = classifyFieldingAction(event)
    if (action.action === 'dive') summary.fielding.dives += 1
    else if (action.action === 'jump') summary.fielding.jumps += 1
    else if (action.action === 'buddy_jump') eventBuddyJumps += 1
    else if (action.action === 'buddy_attack') eventBuddyAttacks += 1
    else summary.fielding.ordinaryEvents += 1
  }
  // These arrays include actions that do not always become a possession event,
  // while a successful action can appear in both places. Keep the larger count
  // on the play instead of double-counting the same button press.
  summary.fielding.buddyJumps += Math.max(eventBuddyJumps, (play.buddy_jumps || []).length)
  summary.fielding.buddyAttacks += Math.max(eventBuddyAttacks, (play.buddy_attacks || []).length)
  summary.fielding.buddyThrows += (play.throws || []).filter((row) => row.buddy_throw === true).length
}

function bridgePitchKey(gameId, pitch, fallback) {
  return `${gameId}:${pitch.pitch_number_game ?? `${pitch.inning}:${pitch.half}:${pitch.pitch_number_pa}:${fallback}`}`
}

function observeBridgePitch(summary, pitch) {
  const classified = classifyPitchInput(pitch)
  if (pitch.pitch_type) {
    summary.pitching.classifiedPitches += 1
    increment(summary.pitching.types, pitch.pitch_type)
  }
  if (classified.type === 'star') summary.pitching.starPitches += 1
  if (classified.type === 'changeup') summary.pitching.changeups += 1
  if (pitch.pitch_charge_frames != null || pitch.pitch_charge != null) summary.pitching.pitchChargeObserved += 1
  if (pitch.plate_x_units != null && pitch.plate_z_units != null) summary.pitching.aimEndpointObserved += 1
  if (Number.isFinite(Number(pitch.pitch_speed_mph))) summary.pitching.measuredVelocity += 1
}

function summarizeBridgeGames(gameIds = null) {
  const summary = fresh()
  const games = {}
  const seen = new Set()
  if (!fs.existsSync(BRIDGE)) return { summary, games }
  for (const name of fs.readdirSync(BRIDGE).filter((entry) => /^season-\d+\.json$/.test(entry)).sort()) {
    const gameId = name.match(/\d+/)[0]
    if (gameIds && !gameIds.has(gameId)) continue
    const state = readJson(path.join(BRIDGE, name))
    const game = fresh()
    game.files = 1
    game.plateAppearances = 0
    game.results = {}
    for (const [eventIndex, event] of (state.events || []).entries()) {
      if (event.pa) {
        game.plateAppearances += 1
        increment(game.results, event.pa.result)
      }
      for (const [pitchIndex, pitch] of (event.pitches || []).entries()) {
        const key = bridgePitchKey(gameId, pitch, `${eventIndex}:${pitchIndex}`)
        if (seen.has(key)) continue
        seen.add(key)
        observeBridgePitch(summary, pitch)
        observeBridgePitch(game, pitch)
      }
    }
    game.records = game.plateAppearances
    games[gameId] = game
    summary.files += 1
    summary.records += game.plateAppearances
  }
  return { summary, games }
}

async function summarizeRawArchive(testStems) {
  const archive = fresh()
  const test = fresh()
  const testByStem = {}
  const names = fs.readdirSync(TRACKING).sort()
  const pitchFiles = names.filter((name) => name.endsWith('.pitches.jsonl') && !name.includes('.pre-recovery.'))
  const playFiles = names.filter((name) => name.endsWith('.plays.jsonl') && !name.includes('.pre-recovery.'))
  for (const name of pitchFiles) {
    const stem = name.slice(0, -'.pitches.jsonl'.length)
    const isTest = testStems.has(stem)
    const game = isTest ? (testByStem[stem] ||= fresh()) : null
    archive.files += 1
    if (game) { game.files += 1; test.files += 1 }
    const count = await eachJsonLine(path.join(TRACKING, name), (pitch) => {
      observePitch(archive, pitch)
      if (isTest) { observePitch(test, pitch); observePitch(game, pitch) }
    })
    archive.records += count
    if (isTest) { test.records += count; game.records += count }
  }
  for (const name of playFiles) {
    const stem = name.slice(0, -'.plays.jsonl'.length)
    const isTest = testStems.has(stem)
    const game = isTest ? (testByStem[stem] ||= fresh()) : null
    archive.files += 1
    if (game) { game.files += 1; test.files += 1 }
    const count = await eachJsonLine(path.join(TRACKING, name), (play) => {
      observePlay(archive, play)
      if (isTest) { observePlay(test, play); observePlay(game, play) }
    })
    archive.records += count
    if (isTest) { test.records += count; game.records += count }
  }
  return { archive, test, testByStem }
}

function testStems() {
  const stems = new Map()
  for (const gameId of TEST_GAME_IDS) {
    const file = path.join(TRACKING, `season-${gameId}.manifest.json`)
    if (!fs.existsSync(file)) continue
    const manifest = readJson(file)
    stems.set(path.basename(manifest.stem), { gameId, park: manifest.park, recordedUtc: manifest.recorded_utc })
  }
  return stems
}

function summarizeCaptureHeaders() {
  const sessions = []
  for (const name of fs.readdirSync(TRACKING).filter((entry) => entry.endsWith('.json') && !entry.includes('.pre-recovery.')).sort()) {
    const stem = name.slice(0, -'.json'.length)
    if (!fs.existsSync(path.join(TRACKING, `${stem}.bin`))) continue
    const header = readJson(path.join(TRACKING, name))
    const regions = new Set((header.extra_regions || []).map((region) => region?.[0]).filter(Boolean))
    const stateBase = Number(header.state_base)
    const stateSize = Number(header.state_size)
    const chargeOffset = 0x900D6A59 - stateBase
    sessions.push({
      stem,
      recordedUtc: header.recorded_utc || null,
      stateSize,
      fullStateBlock: stateBase <= 0x900D5000 && stateBase + stateSize >= 0x900DBD40,
      swingChargeStateCaptured: chargeOffset >= 0 && chargeOffset < stateSize,
      starMeterCaptured: stateBase <= 0x900D4E24 && stateBase + stateSize >= 0x900D4E28,
      controllerInputCaptured: regions.has('wiimote_1_input') && regions.has('wiimote_2_input'),
      calibrationExcluded: header.calibration_excluded === true,
      calibrationExcludedReason: header.calibration_excluded_reason || null,
    })
  }
  const controllerSessions = sessions.filter((session) => session.controllerInputCaptured)
  return {
    sessions: sessions.length,
    fullStateBlockSessions: sessions.filter((session) => session.fullStateBlock).length,
    swingChargeStateCapturedSessions: sessions.filter((session) => session.swingChargeStateCaptured).length,
    starMeterCapturedSessions: sessions.filter((session) => session.starMeterCaptured).length,
    controllerInputCapturedSessions: controllerSessions.length,
    competitiveControllerInputCapturedSessions: controllerSessions.filter((session) => !session.calibrationExcluded).length,
    controllerSessions,
  }
}

const stems = testStems()
const raw = await summarizeRawArchive(new Set(stems.keys()))
const allBridge = summarizeBridgeGames()
const testBridge = summarizeBridgeGames(TEST_GAME_IDS)
const captureCoverage = summarizeCaptureHeaders()
const testGames = {}
for (const [stem, identity] of stems) {
  testGames[identity.gameId] = {
    ...identity,
    stem,
    raw: raw.testByStem[stem] || fresh(),
    scorebook: testBridge.games[identity.gameId] || fresh(),
  }
}

const report = {
  version: USER_VALUE_VERSION,
  generatedAt: new Date().toISOString(),
  scope: {
    rawArchive: 'All non-pre-recovery *.pitches.jsonl and *.plays.jsonl files in data/player_tracking; counts are capture records, not deduplicated official PAs.',
    bridgeArchive: 'All season tracker bridge state files, deduplicated by game and pitch_number_game.',
    testGames: [...TEST_GAME_IDS],
  },
  captureCoverage,
  archive: { raw: raw.archive, scorebook: allBridge.summary },
  test: { raw: raw.test, scorebook: testBridge.summary, games: testGames },
  readiness: {
    batting: {
      now: ['swing/take', 'bunt', 'contact/whiff', 'star swing', 'slap/charge state', 'charge duration', 'charge release relative to swing onset', 'count', 'batted-ball quality'],
      missing: ['independent power/contact timing marker'],
    },
    pitching: {
      now: ['classified pitch movement/type', 'velocity', 'horizontal/vertical movement', 'absolute plate endpoint', 'count', 'result', 'star pitch from a fielding-side meter spend when the expanded state block is present'],
      missing: ['normal/changeup input independent of inferred pitch class', 'charge state/duration', 'user aim target before movement'],
    },
    baserunning: {
      now: ['runner speed', 'splits', 'path', 'result'],
      missing: ['shake input/onset/duration'],
      attribution: 'Advance/hold is automatic in the no-Nunchuk league and must not be credited as user decision value.',
    },
    fielding: {
      now: ['route', 'speed', 'dive', 'jump/leap', 'buddy jump', 'buddy attack', 'buddy throw', 'throw quality', 'catch result'],
      missing: ['shake input/onset/duration', 'raw action edges for attempts with no animation or contact'],
      attribution: 'Selection, positioning, route, ordinary catch, and ordinary throw target are automatic; only explicit actions and sprint execution enter UVA.',
    },
  },
  constraints: {
    controllerInput: 'Only scripted calibration sessions capture both Wii Remote structs; no normal competitive session has raw controller input.',
    starMeter: 'Only captures using the expanded state block contain team star meters; positive spends are exact star-use evidence, while older sessions retain their existing tracker/scorer flags.',
    attribution: 'Recovered observations support descriptive rates, but player-versus-character run attribution still requires counterfactual models and player/character crossover validation.',
  },
}

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true })
fs.writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`)
console.log(`Wrote ${path.relative(ROOT, OUTPUT)}`)
console.log(JSON.stringify({
  rawFiles: report.archive.raw.files,
  rawRecords: report.archive.raw.records,
  rawPitches: report.archive.raw.batting.pitches,
  rawPlays: report.archive.raw.records - report.archive.raw.batting.pitches,
  testPitches: report.test.raw.batting.pitches,
  testGames: Object.keys(report.test.games).length,
}, null, 2))
