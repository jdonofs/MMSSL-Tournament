import { TRACKER_POSITION_NUMBERS, parseTrackerLineupMessage, parseTrackerRunnerMessage } from './tracker_alignment.mjs'
import {
  applyTrackerBattedBallToBuffer,
  applyTrackerFieldedBallToBuffer,
  isTrackerRobbedHomeRun,
  parseTrackerBattedBallMessage,
  parseTrackerFieldedBallMessage,
  parseTrackerHitByPitchMessage,
  parseTrackerPutoutMessage,
  shouldChargeTrackerBobbleError,
  shouldClassifyTrackerFielderChoice,
  trackerBattedBallPaFields,
  trackerCaughtBallResult,
  trackerFieldedBallPaFields,
} from './tracker_play_events.mjs'
import { getStadiumKeyByName } from '../src/utils/stadiums.js'
import { assembleErrorNotation } from '../src/utils/notation.js'

const OUT_RESULTS = new Set(['K', 'GO', 'FO', 'LO', 'DP', 'TP', 'SF', 'SH'])

function freshPa(state, pitcherName, batterName) {
  state.localPaNumber += 1
  return {
    localPaNumber: state.localPaNumber,
    pitcherName,
    batterName,
    inning: state.inning,
    isTop: state.isTop,
    outsBeforePa: state.outs,
    countSeen: false,
    lastCount: { balls: 0, strikes: 0 },
    pendingPitchType: null,
    pendingStarPitch: false,
    pendingDoublePlay: false,
    pendingTriplePlay: false,
    contactRecorded: false,
    pitches: [],
    result: null,
    rbi: 0,
    runEvents: [],
    runnersBefore: { first: null, second: null, third: null },
    starHitUsed: false,
    battedBallTrajectory: null,
    advancedBattedBall: null,
    advancedFielding: null,
    observedPutouts: [],
    assistFielderNames: [],
    putoutFielderName: null,
    bobbleFielderName: null,
    isBuddyJump: false,
    buddyJumpFielderName: null,
    messages: [],
  }
}

function pushPitch(state, pa, type, before = pa.lastCount, after = pa.lastCount) {
  state.gamePitchNumber += 1
  pa.pitches.push({
    pitch_number_pa: pa.pitches.length + 1,
    pitch_number_game: state.gamePitchNumber,
    result: type,
    pitch_type: null,
    is_star_pitch: Boolean(pa.pendingStarPitch),
    count_balls_before: before.balls,
    count_strikes_before: before.strikes,
    count_balls_after: after.balls,
    count_strikes_after: after.strikes,
  })
  pa.pendingStarPitch = false
}

function ensureContactPitch(state, pa) {
  if (pa.contactRecorded) return
  pushPitch(state, pa, 'in_play')
  pa.contactRecorded = true
}

function applyPendingMultiOut(pa) {
  if (!['GO', 'FO', 'LO'].includes(pa.result)) return
  if (pa.pendingTriplePlay) pa.result = 'TP'
  else if (pa.pendingDoublePlay) pa.result = 'DP'
}

function fieldingPosition(state, fielderName, pitcherName) {
  for (const alignment of Object.values(state.alignments)) {
    if (!alignment.batting.includes(pitcherName)) continue
    const position = Object.entries(alignment.fielding).find(([, name]) => name === fielderName)?.[0]
    if (position) return TRACKER_POSITION_NUMBERS[position] ?? null
  }
  return null
}

function resultOuts(result, observedPutouts) {
  if (result === 'TP') return 3
  if (result === 'DP') return 2
  const resultOut = OUT_RESULTS.has(result) || result === 'FC' ? 1 : 0
  return Math.max(resultOut, observedPutouts.length)
}

function exactRunnerAssignments(pa, nextRunners) {
  const nextBaseByName = new Map()
  for (const base of ['first', 'second', 'third']) {
    if (nextRunners[base]) nextBaseByName.set(nextRunners[base], base)
  }
  const scorers = new Set(pa.runEvents.map((run) => run.scorerName))
  const outs = new Set(pa.observedPutouts.map((putout) => putout.runnerName))
  const batterOut = ['K', 'GO', 'FO', 'LO', 'SF', 'SH'].includes(normalizedResult(pa))
  const entries = [
    { id: 'batter', runner: { characterName: pa.batterName }, origin: 'plate', isBatter: true },
    ...['first', 'second', 'third'].filter((base) => pa.runnersBefore[base]).map((base) => ({
      id: base, runner: { characterName: pa.runnersBefore[base] }, origin: base, isBatter: false,
    })),
  ]
  const assignments = []
  for (const entry of entries) {
    const name = entry.runner.characterName
    const destination = nextBaseByName.get(name)
      || (scorers.has(name) ? 'home' : null)
      || (outs.has(name) || (entry.isBatter && batterOut) ? 'out' : null)
    if (!destination) return null
    assignments.push({ ...entry, destination })
  }
  return assignments
}

function normalizedResult(pa) {
  let result = pa.result
  if (!result && shouldClassifyTrackerFielderChoice(pa)) result = 'FC'
  if (result === 'FO' && pa.battedBallTrajectory === 'L') result = 'LO'
  const error = shouldChargeTrackerBobbleError({ bobbleFielderName: pa.bobbleFielderName, result })
  if (error && ['1B', '2B', '3B'].includes(result)) result = 'ROE'
  if (
    result === 'FO'
    && pa.outsBeforePa < 2
    && pa.runEvents.some((run) => run.scorerName !== pa.batterName)
  ) result = 'SF'
  return result
}

function serializePa(state, pa, runnerAssignments = pa.exactRunnerAssignments || null) {
  if (!pa) return null
  const result = normalizedResult(pa)
  const isError = shouldChargeTrackerBobbleError({ bobbleFielderName: pa.bobbleFielderName, result: pa.result })
  const errorPosition = isError ? fieldingPosition(state, pa.bobbleFielderName, pa.pitcherName) : null
  const chainNames = [...pa.assistFielderNames, pa.putoutFielderName].filter(Boolean)
  const chainPositions = chainNames.map((name) => fieldingPosition(state, name, pa.pitcherName)).filter((value) => value != null)
  let hitNotation = chainPositions.length
    ? `${pa.battedBallTrajectory || (result === 'FO' ? 'F' : result === 'LO' ? 'L' : 'G')}${chainPositions.join('-')}`
    : null
  let errorNotation = null
  if (isError && errorPosition != null) {
    errorNotation = assembleErrorNotation(pa.battedBallTrajectory || 'G', [errorPosition], errorPosition)
    hitNotation = errorNotation
  }
  const outsOnPlay = resultOuts(result, pa.observedPutouts)
  const decisivePitch = pa.pitches.at(-1)
  const batterRun = pa.runEvents.find((run) => run.scorerName === pa.batterName)
  return {
    preview_only: true,
    saved_to_database: false,
    pa_number: pa.localPaNumber,
    inning: pa.inning,
    half: pa.isTop ? 'top' : 'bottom',
    batter_name: pa.batterName,
    pitcher_name: pa.pitcherName,
    result,
    outs_on_play: outsOnPlay,
    rbi: pa.rbi,
    run_scored: Boolean(batterRun) || result === 'HR' || result === 'IPHR',
    is_official_ab: result ? !['BB', 'HBP', 'SF', 'SH'].includes(result) : null,
    is_earned_run: batterRun ? batterRun.earnedRun === true : !isError,
    runner_on_first_before: Boolean(pa.runnersBefore.first),
    runner_on_second_before: Boolean(pa.runnersBefore.second),
    runner_on_third_before: Boolean(pa.runnersBefore.third),
    runners_before: { ...pa.runnersBefore },
    runner_assignments: runnerAssignments,
    trajectory: pa.battedBallTrajectory,
    hit_notation: hitNotation,
    fielder_choice_out: result === 'FC',
    is_error: isError,
    error_position: errorPosition,
    error_character: isError ? pa.bobbleFielderName : null,
    error_player: null,
    error_notation: errorNotation,
    is_nice_play: false,
    star_hit_used: Boolean(pa.starHitUsed),
    star_pitch_used: Boolean(decisivePitch?.is_star_pitch),
    star_pitch_successful: Boolean(decisivePitch?.is_star_pitch && outsOnPlay > 0),
    is_buddy_jump: Boolean(pa.isBuddyJump),
    buddy_jump_assist_position: pa.isBuddyJump && pa.assistFielderNames[0]
      ? fieldingPosition(state, pa.assistFielderNames[0], pa.pitcherName) : null,
    buddy_jump_putout_position: pa.isBuddyJump
      ? fieldingPosition(state, pa.buddyJumpFielderName, pa.pitcherName) : null,
    is_robbed_hr: isTrackerRobbedHomeRun({
      record: pa.advancedBattedBall,
      isBuddyJump: pa.isBuddyJump,
      stadiumKey: state.stadiumKey,
    }),
    strikeout_type: result === 'K'
      ? (decisivePitch?.result === 'looking' ? 'KL'
        : decisivePitch?.result === 'swinging_miss' ? 'KS' : null)
      : null,
    hit_stadium_key: state.stadiumKey,
    ...trackerBattedBallPaFields(pa.advancedBattedBall, { stadiumKey: state.stadiumKey }),
    ...trackerFieldedBallPaFields(pa.advancedFielding, { stadiumKey: state.stadiumKey }),
    pitches: pa.pitches.map((pitch) => ({ ...pitch })),
    runs_scored: pa.runEvents.map((run) => ({
      scoring_character_name: run.scorerName,
      charged_to_pitcher_name: run.chargedToPitcherName || pa.pitcherName,
      is_earned_run: run.earnedRun === true,
    })),
    fielding_events: {
      assists: [...pa.assistFielderNames],
      putouts: pa.observedPutouts.map(({ fielderName, runnerName }) => ({ fielderName, runnerName })),
      bobble: pa.bobbleFielderName,
    },
    advanced_batted_ball_raw: pa.advancedBattedBall,
    advanced_fielding_raw: pa.advancedFielding,
    recent_messages: pa.messages.slice(-80),
  }
}

function paHasActivity(pa) {
  return Boolean(pa && (
    pa.pitches.length || pa.result || pa.pendingPitchType || pa.contactRecorded
    || pa.advancedBattedBall || pa.advancedFielding || pa.observedPutouts.length
  ))
}

export function createTrackerPreviewState() {
  return {
    connected: false,
    trackerStatus: 'waiting',
    trackerPid: null,
    startedAt: new Date().toISOString(),
    lastMessageAt: null,
    inning: 1,
    isTop: true,
    outs: 0,
    stadiumName: null,
    stadiumKey: null,
    localPaNumber: 0,
    gamePitchNumber: 0,
    alignments: {},
    current: null,
    latestCompletedBuffer: null,
    latestCompleted: null,
    revision: 0,
    events: [],
  }
}

export function applyTrackerPreviewMessage(state, message) {
  const clean = String(message || '').trim()
  if (!clean) return state
  state.connected = true
  state.trackerStatus = 'receiving tracker output'
  state.lastMessageAt = new Date().toISOString()
  state.events.push(clean)
  if (state.events.length > 300) state.events.splice(0, state.events.length - 300)

  let match
  const lineup = parseTrackerLineupMessage(clean)
  if (lineup) {
    state.alignments[lineup.teamName] = lineup
    return state
  }
  if ((match = clean.match(/^(.+?)\s+vs\.\s+(.+?)\s+@\s+(.+)$/))) {
    state.stadiumName = match[3].trim()
    state.stadiumKey = getStadiumKeyByName(state.stadiumName)
    return state
  }
  if ((match = clean.match(/^Next:\s*(Top|Bottom) of inning (\d+)$/i))) {
    state.isTop = /^Top$/i.test(match[1])
    state.inning = Number(match[2])
    state.outs = 0
    return state
  }
  if ((match = clean.match(/^(\d+)\s+outs?$/i))) {
    state.outs = Number(match[1])
    return state
  }
  if ((match = clean.match(/^(.+?)\s+vs\.\s+(.+)$/)) && !clean.includes(' @ ')) {
    if (state.current) {
      state.latestCompletedBuffer = state.current
      state.latestCompleted = serializePa(state, state.current)
      state.revision += 1
    }
    state.current = freshPa(state, match[1].trim(), match[2].trim())
    return state
  }

  const pa = state.current
  if (!pa) return state
  pa.messages.push(clean)

  const runner = parseTrackerRunnerMessage(clean)
  if (runner) {
    pa.runnersBefore[runner.base] = runner.characterName
    return state
  }
  if ((match = clean.match(/^Count:\s*(\d)-(\d)$/i))) {
    const next = { balls: Number(match[1]), strikes: Number(match[2]) }
    if (!pa.countSeen) {
      pa.countSeen = true
      pa.lastCount = next
      if (state.latestCompletedBuffer) {
        const assignments = exactRunnerAssignments(state.latestCompletedBuffer, pa.runnersBefore)
        state.latestCompletedBuffer.exactRunnerAssignments = assignments
        state.latestCompleted = serializePa(state, state.latestCompletedBuffer, assignments)
      }
      return state
    }
    const type = pa.pendingPitchType === 'strike'
      ? 'strike_unknown' : pa.pendingPitchType === 'foul' ? 'foul' : 'ball'
    pushPitch(state, pa, type, pa.lastCount, next)
    pa.pendingPitchType = null
    pa.lastCount = next
    if (next.balls >= 4) pa.result = pa.result || 'BB'
    return state
  }
  if (/^Strike\s+\d+\.$/i.test(clean)) { pa.pendingPitchType = 'strike'; return state }
  if (/^Foul ball!$/i.test(clean)) { pa.pendingPitchType = 'foul'; return state }
  if (/^Fair ball!$/i.test(clean)) { ensureContactPitch(state, pa); return state }

  const hbpBatter = parseTrackerHitByPitchMessage(clean)
  if (hbpBatter === pa.batterName) {
    pushPitch(state, pa, 'hbp')
    pa.result = 'HBP'
    return state
  }
  if (clean.startsWith('[TRACKER_BATTED_BALL_PROVISIONAL]')) {
    const record = parseTrackerBattedBallMessage(clean)
    if (record) applyTrackerBattedBallToBuffer(pa, record)
    return state
  }
  if (clean.startsWith('[TRACKER_BALL_FIELDED_PROVISIONAL]')) {
    const record = parseTrackerFieldedBallMessage(clean)
    if (record) applyTrackerFieldedBallToBuffer(pa, record)
    return state
  }
  if (/^Double play!$/i.test(clean)) {
    if (['GO', 'FO', 'LO'].includes(pa.result)) pa.result = 'DP'
    else pa.pendingDoublePlay = true
    return state
  }
  if (/^Triple play!$/i.test(clean)) {
    if (['GO', 'FO', 'LO'].includes(pa.result)) pa.result = 'TP'
    else pa.pendingTriplePlay = true
    return state
  }
  if ((match = clean.match(/^(.+?)'s hit was caught!$/i)) && match[1].trim() === pa.batterName) {
    ensureContactPitch(state, pa)
    pa.result = trackerCaughtBallResult(pa.advancedBattedBall)
    pa.battedBallTrajectory = pa.battedBallTrajectory || (pa.result === 'LO' ? 'L' : 'F')
    applyPendingMultiOut(pa)
    return state
  }
  const putout = parseTrackerPutoutMessage(clean)
  if (putout) {
    if (!pa.observedPutouts.some((entry) => entry.fielderName === putout.fielderName && entry.runnerName === putout.runnerName)) {
      pa.observedPutouts.push(putout)
    }
    pa.putoutFielderName = putout.fielderName
    if (!pa.result && putout.runnerName === pa.batterName) {
      ensureContactPitch(state, pa)
      pa.result = 'GO'
      pa.battedBallTrajectory = pa.battedBallTrajectory || 'G'
      applyPendingMultiOut(pa)
    }
    return state
  }
  if ((match = clean.match(/^(.+?)\s+recorded an assist!$/i))) {
    pa.assistFielderNames.push(match[1].trim())
    return state
  }
  if ((match = clean.match(/^(.+?)\s+bobbled the ball!$/i))) {
    pa.bobbleFielderName = match[1].trim()
    return state
  }
  if ((match = clean.match(/^(.+?)\s+is going up for a buddy jump!$/i))) {
    pa.buddyJumpFielderName = match[1].trim()
    return state
  }
  if ((match = clean.match(/^(.+?)\s+went high up with the buddy jump to get the out!$/i))) {
    pa.isBuddyJump = true
    pa.buddyJumpFielderName = match[1].trim()
    return state
  }
  if ((match = clean.match(/^(.+?)\s+used a star pitch!$/i)) && match[1].trim() === pa.pitcherName) {
    pa.pendingStarPitch = true
    return state
  }
  if ((match = clean.match(/^(.+?)\s+used a star swing!$/i)) && match[1].trim() === pa.batterName) {
    pa.starHitUsed = true
    return state
  }
  if (!pa.result) {
    if ((match = clean.match(/^(.+?)\s+recorded an? (?:star )?single!$/i)) && match[1].trim() === pa.batterName) { ensureContactPitch(state, pa); pa.result = '1B'; return state }
    if ((match = clean.match(/^(.+?)\s+recorded an? (?:star )?double!$/i)) && match[1].trim() === pa.batterName) { ensureContactPitch(state, pa); pa.result = '2B'; return state }
    if ((match = clean.match(/^(.+?)\s+recorded an? (?:star )?triple!$/i)) && match[1].trim() === pa.batterName) { ensureContactPitch(state, pa); pa.result = '3B'; return state }
    if ((match = clean.match(/^(.+?)\s+recorded an? (?:star )?inside the park home run!$/i)) && match[1].trim() === pa.batterName) { ensureContactPitch(state, pa); pa.result = 'IPHR'; return state }
    if ((match = clean.match(/^(.+?)\s+hits an?\s+.*(?:homer|home run).*off of\s+.+!$/i)) && match[1].trim() === pa.batterName) { ensureContactPitch(state, pa); pa.result = 'HR'; return state }
    if ((match = clean.match(/^.+?\s+struck out\s+(.+?)!$/i)) && match[1].trim() === pa.batterName) { pa.result = 'K'; return state }
  }
  if ((match = clean.match(/^(.+?)\s+recorded (\d+) RBI!$/i)) && match[1].trim() === pa.batterName) {
    pa.rbi = Number(match[2])
    return state
  }
  if ((match = clean.match(/^(.+?)\s+recorded a run!$/i))) {
    pa.runEvents.push({ scorerName: match[1].trim(), chargedToPitcherName: null, earnedRun: false })
    return state
  }
  if ((match = clean.match(/^(.+?)\s+was charged with an? earned run$/i))) {
    const run = pa.runEvents.at(-1)
    if (run) { run.chargedToPitcherName = match[1].trim(); run.earnedRun = true }
    return state
  }
  if ((match = clean.match(/^.+?\s+inherited this runner from (.+?)\.\s+(.+?)\s+will be charged any earned runs\.$/i))) {
    const run = pa.runEvents.at(-1)
    if (run && match[1].trim() === match[2].trim()) run.chargedToPitcherName = match[1].trim()
  }
  return state
}

export function trackerPreviewSnapshot(state) {
  const current = paHasActivity(state.current) ? serializePa(state, state.current) : null
  return {
    mode: 'local_preview',
    writes_enabled: false,
    connected: state.connected,
    tracker_status: state.trackerStatus,
    tracker_pid: state.trackerPid,
    started_at: state.startedAt,
    last_message_at: state.lastMessageAt,
    stadium_name: state.stadiumName,
    stadium_key: state.stadiumKey,
    revision: state.revision,
    display_at_bat: current || state.latestCompleted,
    current_at_bat: state.current ? serializePa(state, state.current) : null,
    last_completed_at_bat: state.latestCompleted,
    recent_tracker_messages: state.events.slice(-100),
  }
}
