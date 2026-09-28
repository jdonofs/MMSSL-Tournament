// User Value Added (UVA) is deliberately separate from WAR. WAR describes the
// value of the player/character performance that happened. UVA asks the
// narrower causal question: how much of that value moved because of an input
// the human was actually allowed to make?
export const USER_VALUE_VERSION = 'sluggers-uva-v1'

const finite = (value) => value != null && value !== '' && Number.isFinite(Number(value))
  ? Number(value)
  : null

const roundNoise = (value) => Math.abs(value) < 1e-12 ? 0 : value

export const USER_AGENCY = Object.freeze({
  batting: Object.freeze({
    userControlled: Object.freeze(['swing_or_take', 'bunt', 'star_swing', 'slap_or_charge', 'charge_timing', 'swing_timing']),
    automatic: Object.freeze(['batter_translation_to_pitch']),
  }),
  pitching: Object.freeze({
    userControlled: Object.freeze(['normal_or_changeup', 'pitch_charge', 'aim', 'star_pitch']),
    automatic: Object.freeze(['character_pitch_shape', 'character_velocity_response']),
  }),
  baserunning: Object.freeze({
    userControlled: Object.freeze(['shake_sprint']),
    automatic: Object.freeze(['advance_or_hold', 'runner_selection', 'route']),
  }),
  fielding: Object.freeze({
    userControlled: Object.freeze(['shake_sprint', 'dive', 'jump', 'buddy_jump', 'buddy_attack']),
    automatic: Object.freeze(['fielder_selection', 'route', 'positioning', 'ordinary_catch', 'ordinary_throw_target']),
  }),
})

// Current Baseball Savant Fielding Run Value conversions for range OAA.
export const OAA_RUNS_PER_OUT = Object.freeze({ infield: 0.75, outfield: 0.90 })

export function fieldingRunsPerOaa(position) {
  const normalized = String(position ?? '').trim().toUpperCase()
  if (['7', '8', '9', 'LF', 'CF', 'RF'].includes(normalized)) return OAA_RUNS_PER_OUT.outfield
  return OAA_RUNS_PER_OUT.infield
}

export function fieldingRunValue(outsAboveAverage, position) {
  const outs = finite(outsAboveAverage)
  return outs == null ? null : outs * fieldingRunsPerOaa(position)
}

/** Report only swing modes the tracker actually observed. */
export function classifySwingMode(record = {}) {
  const explicit = String(record.swing_mode ?? record.swing_type ?? '').trim().toLowerCase()
  if (['slap', 'charge'].includes(explicit)) {
    return { mode: explicit, observed: true, source: record.swing_mode != null ? 'swing_mode' : 'swing_type' }
  }
  if (record.bunt === true || finite(record.bunt_frames) > 0 || explicit === 'bunt') {
    return { mode: 'bunt', observed: true, source: record.bunt === true ? 'bunt' : explicit === 'bunt' ? 'swing_type' : 'bunt_frames' }
  }
  if (record.is_star_swing === true || Boolean(record.star_swing) || finite(record.batting_star_meter_spent) > 0 || explicit === 'star') {
    return {
      mode: 'star',
      observed: true,
      source: record.is_star_swing === true
        ? 'is_star_swing'
        : Boolean(record.star_swing)
          ? 'star_swing'
          : finite(record.batting_star_meter_spent) > 0
            ? 'batting_star_meter_spent'
            : 'swing_type',
    }
  }
  // The pitch deriver decides the offer from the bat state at the plate. A
  // late swing, a pulled-back bunt, or stale animation frames can therefore
  // coexist with an explicit take. The resolved offer outranks those counters.
  if (explicit === 'none' || record.offer === 'take' || record.swing_offer === 'take') {
    return { mode: 'none', observed: true, source: explicit === 'none' ? 'swing_mode' : 'no_offer' }
  }
  const offered = record.offer === 'swing' || record.swing_shown === true || finite(record.swing_frames) > 0
  if (offered) return { mode: 'ordinary_unknown', observed: false, source: 'swing_observed_charge_state_missing' }
  return { mode: 'none', observed: true, source: 'no_offer' }
}

export function classifyPitchInput(record = {}) {
  if (finite(record.fielding_star_meter_spent) > 0) {
    return { type: 'star', observed: true, source: 'fielding_star_meter_spent' }
  }
  if (record.is_star_pitch === true) return { type: 'star', observed: true, source: 'is_star_pitch' }
  const explicit = String(record.pitch_input_type ?? '').trim().toLowerCase()
  if (['normal', 'changeup'].includes(explicit)) return { type: explicit, observed: true, source: 'pitch_input_type' }
  if (String(record.pitch_type ?? '').toLowerCase() === 'changeup') return { type: 'changeup', observed: true, source: 'pitch_type' }
  // Fastball/curveball are movement classifications, not proof of charge input.
  return { type: 'normal_or_charged_unknown', observed: false, source: 'input_type_missing' }
}

export function classifyFieldingAction(event = {}) {
  const mechanic = String(event.mechanic ?? event.approach ?? event.event_type ?? '').toLowerCase()
  if (event.buddy_jump === true || mechanic.includes('buddy_jump')) return { action: 'buddy_jump', userControlled: true }
  if (event.buddy_attack === true || mechanic.includes('buddy_attack') || mechanic === 'buddy') return { action: 'buddy_attack', userControlled: true }
  if (event.dive === true || mechanic === 'dive') return { action: 'dive', userControlled: true }
  if (event.leap === true || event.jump === true || ['leap', 'jump'].includes(mechanic)) return { action: 'jump', userControlled: true }
  return { action: 'ordinary', userControlled: false }
}

/**
 * Conserving attribution. Each expectation is the same play with one more
 * layer admitted: environment -> character -> decision -> execution -> result.
 */
export function decomposeRunValue({
  leagueExpectedRuns,
  gameExpectedRuns,
  characterExpectedRuns,
  decisionExpectedRuns,
  executionExpectedRuns,
  actualRuns,
  decisionIsUserControlled,
  executionIsUserControlled,
  confidence = 'modelled',
  evidence = [],
} = {}) {
  const values = [leagueExpectedRuns, gameExpectedRuns, characterExpectedRuns, decisionExpectedRuns, executionExpectedRuns, actualRuns].map(finite)
  if (values.some((value) => value == null)) return null
  const [league, game, character, decision, execution, actual] = values
  const decisionDelta = decision - character
  const executionDelta = execution - decision
  const userDecisionRuns = decisionIsUserControlled ? decisionDelta : 0
  const userExecutionRuns = executionIsUserControlled ? executionDelta : 0
  const result = {
    version: USER_VALUE_VERSION,
    observedRunsAboveAverage: roundNoise(actual - league),
    gameRuns: roundNoise(game - league),
    characterRuns: roundNoise(character - game),
    userDecisionRuns: roundNoise(userDecisionRuns),
    userExecutionRuns: roundNoise(userExecutionRuns),
    automaticDecisionRuns: roundNoise(decisionIsUserControlled ? 0 : decisionDelta),
    automaticExecutionRuns: roundNoise(executionIsUserControlled ? 0 : executionDelta),
    residualRuns: roundNoise(actual - execution),
    userRuns: roundNoise(userDecisionRuns + userExecutionRuns),
    confidence,
    evidence: [...evidence],
  }
  result.reconciledRuns = roundNoise(
    result.gameRuns + result.characterRuns + result.userDecisionRuns + result.userExecutionRuns
    + result.automaticDecisionRuns + result.automaticExecutionRuns + result.residualRuns,
  )
  return result
}

export function scoreFieldingAction({ position, expectedOutProbabilityWithoutAction, expectedOutProbabilityWithAction, action, confidence = 'modelled' } = {}) {
  const withoutAction = finite(expectedOutProbabilityWithoutAction)
  const withAction = finite(expectedOutProbabilityWithAction)
  if (withoutAction == null || withAction == null) return null
  const classified = classifyFieldingAction(action || {})
  return {
    ...classified,
    runs: classified.userControlled ? (withAction - withoutAction) * fieldingRunsPerOaa(position) : 0,
    confidence,
  }
}

export function scoreSprintExecution({ expectedRunsAtObservedEffort, expectedRunsAtNeutralEffort, inputObserved = false, direction = 'offense' } = {}) {
  const observed = finite(expectedRunsAtObservedEffort)
  const neutral = finite(expectedRunsAtNeutralEffort)
  if (observed == null || neutral == null) return null
  const sign = direction === 'defense' ? -1 : 1
  return {
    runs: sign * (observed - neutral),
    confidence: inputObserved ? 'observed_input' : 'inferred_from_speed',
    inputObserved: Boolean(inputObserved),
  }
}

export function aggregateUserValue(rows = []) {
  const valid = rows.filter(Boolean)
  const total = (key) => valid.reduce((sum, row) => sum + (finite(row[key]) ?? 0), 0)
  const userDecisionRuns = total('userDecisionRuns')
  const userExecutionRuns = total('userExecutionRuns')
  return {
    version: USER_VALUE_VERSION,
    opportunities: valid.length,
    userDecisionRuns,
    userExecutionRuns,
    userRuns: userDecisionRuns + userExecutionRuns,
    observedRunsAboveAverage: total('observedRunsAboveAverage'),
    residualRuns: total('residualRuns'),
  }
}

const SWING_RESULTS = new Set(['swinging_miss', 'foul', 'in_play'])
const TAKE_RESULTS = new Set(['ball', 'looking', 'called_strike', 'hbp'])

function emptyIdentityRow(id) {
  return {
    id: String(id),
    batting: {
      decisionRuns: 0, executionRuns: 0, modeledDecisions: 0, modeledExecutions: 0,
      pitches: 0, knownDecisions: 0, swings: 0, takes: 0, contacts: 0,
      bunts: 0, starSwings: 0, slapSwings: 0, chargeSwings: 0,
      outsideZonePitches: 0, insideZonePitches: 0, shadowPitches: 0,
      chases: 0, chaseContacts: 0, zoneSwings: 0,
    },
    pitching: {
      decisionRuns: 0, executionRuns: 0, modeledDecisions: 0, modeledExecutions: 0,
      pitches: 0, inputObserved: 0, changeups: 0, starPitches: 0,
      aimObserved: 0, chargeObserved: 0,
    },
    baserunning: {
      executionRuns: 0, modeledExecutions: 0, sprintSamples: 0, sprintSpeedTotal: 0,
      shakeObserved: 0, automaticRuns: 0, automaticModeled: 0,
    },
    fielding: {
      decisionRuns: 0, executionRuns: 0, modeledDecisions: 0, modeledExecutions: 0,
      actionAttempts: 0, buddyAttacks: 0, buddyAttackContacts: 0,
      buddyObjectClears: 0, buddyJumpAttempts: 0, rangeRuns: 0, rangeModeled: 0,
    },
  }
}

function optionalMetric(record, paths) {
  for (const path of paths) {
    const value = path.split('.').reduce((current, key) => current?.[key], record)
    const parsed = finite(value)
    if (parsed != null) return parsed
  }
  return null
}

function addMetric(bucket, key, countKey, value) {
  if (value == null) return
  bucket[key] += value
  bucket[countKey] += 1
}

const paJoinKey = (row) => `${row?.game_id}:${row?.pa_id ?? row?.id}`

/**
 * Build the Stats-page UVA rows from optional modeled values plus the input
 * evidence already persisted today. Optional run fields are intentionally
 * duck-typed so a tracker migration can begin populating them without making
 * older rows disappear or count as zero.
 */
export function buildUserValueStats({
  plateAppearances = [], pitches = [], movementMetrics = [], runnerOpportunities = [],
  fieldingOpportunities = [], trackingPlays = [], identity = 'player',
} = {}) {
  const rows = new Map()
  const identityField = identity === 'character' ? 'character_id' : 'player_id'
  const ensure = (id) => {
    if (id == null || id === '') return null
    const key = String(id)
    if (!rows.has(key)) rows.set(key, emptyIdentityRow(key))
    return rows.get(key)
  }
  const pasByKey = new Map(plateAppearances.map((pa) => [paJoinKey(pa), pa]))
  const starSwingPas = new Set()

  for (const pitch of pitches) {
    const pa = pasByKey.get(paJoinKey(pitch))
    if (!pa) continue
    const batter = ensure(pa[identityField])
    if (batter) {
      const stats = batter.batting
      stats.pitches += 1
      if (SWING_RESULTS.has(pitch.result)) { stats.swings += 1; stats.knownDecisions += 1 }
      else if (TAKE_RESULTS.has(pitch.result)) { stats.takes += 1; stats.knownDecisions += 1 }
      if (['foul', 'in_play'].includes(pitch.result)) stats.contacts += 1
      const mode = classifySwingMode(pitch)
      if (mode.mode === 'star') starSwingPas.add(paJoinKey(pa))
      if (mode.mode === 'slap') stats.slapSwings += 1
      if (mode.mode === 'charge') stats.chargeSwings += 1
      const zone = String(pitch.pitch_zone ?? '').toLowerCase()
      const ordinaryOffer = pitch.swing_offer === 'swing'
        || (SWING_RESULTS.has(pitch.result) && mode.mode !== 'bunt')
      if (zone === 'out') {
        stats.outsideZonePitches += 1
        if (pitch.is_chase === true || ordinaryOffer) {
          stats.chases += 1
          if (['foul', 'in_play'].includes(pitch.result)) stats.chaseContacts += 1
        }
      } else if (zone === 'in') {
        stats.insideZonePitches += 1
        if (ordinaryOffer) stats.zoneSwings += 1
      } else if (zone === 'shadow') stats.shadowPitches += 1
      addMetric(stats, 'decisionRuns', 'modeledDecisions', optionalMetric(pitch, [
        'bat_user_decision_runs', 'user_value.batting_decision_runs',
      ]))
      addMetric(stats, 'executionRuns', 'modeledExecutions', optionalMetric(pitch, [
        'bat_user_execution_runs', 'user_value.batting_execution_runs',
      ]))
    }

    const pitcherId = identity === 'character' ? pa.pitcher_id : pa.pitcher_player_id
    const pitcher = ensure(pitcherId)
    if (!pitcher) continue
    const stats = pitcher.pitching
    stats.pitches += 1
    const input = classifyPitchInput(pitch)
    if (input.observed) stats.inputObserved += 1
    if (input.type === 'changeup') stats.changeups += 1
    if (input.type === 'star') stats.starPitches += 1
    if (pitch.plate_x_units != null && pitch.plate_z_units != null) stats.aimObserved += 1
    if (pitch.pitch_charge_frames != null || pitch.pitch_charge != null) stats.chargeObserved += 1
    addMetric(stats, 'decisionRuns', 'modeledDecisions', optionalMetric(pitch, [
      'pitch_user_decision_runs', 'user_value.pitching_decision_runs',
    ]))
    addMetric(stats, 'executionRuns', 'modeledExecutions', optionalMetric(pitch, [
      'pitch_user_execution_runs', 'user_value.pitching_execution_runs',
    ]))
  }

  for (const pa of plateAppearances) {
    const row = ensure(pa[identityField])
    if (!row) continue
    if (pa.result === 'SH') row.batting.bunts += 1
    if (pa.star_hit_used === true || starSwingPas.has(paJoinKey(pa))) row.batting.starSwings += 1
    addMetric(row.batting, 'decisionRuns', 'modeledDecisions', optionalMetric(pa, [
      'star_swing_decision_runs', 'user_value.star_swing_decision_runs',
    ]))
  }

  for (const movement of movementMetrics) {
    if (!['runner', 'batter'].includes(movement.actor_type)) continue
    const row = ensure(movement[identityField])
    if (!row) continue
    const speed = finite(movement.sprint_speed_fps)
    const distance = finite(movement.path_distance_m)
    if (speed != null && speed > 0 && (distance == null || distance >= 15)) {
      row.baserunning.sprintSamples += 1
      row.baserunning.sprintSpeedTotal += speed
    }
    if (movement.shake_input === true || movement.shake_frames != null) row.baserunning.shakeObserved += 1
    addMetric(row.baserunning, 'executionRuns', 'modeledExecutions', optionalMetric(movement, [
      'user_execution_runs', 'user_value.baserunning_execution_runs',
    ]))
  }

  for (const opportunity of runnerOpportunities) {
    const id = identity === 'character' ? opportunity.runner_character_id : opportunity.runner_player_id
    const row = ensure(id)
    if (!row) continue
    const automatic = finite(opportunity.runner_run_value)
    if (automatic != null) {
      row.baserunning.automaticRuns += automatic
      row.baserunning.automaticModeled += 1
    }
  }

  for (const opportunity of fieldingOpportunities) {
    const id = identity === 'character' ? opportunity.fielder_character_id : opportunity.fielder_player_id
    const row = ensure(id)
    if (!row) continue
    const stats = row.fielding
    const oaa = finite(opportunity.outs_above_average)
    if (opportunity.is_primary && oaa != null) {
      stats.rangeRuns += fieldingRunValue(oaa, opportunity.position)
      stats.rangeModeled += 1
    }
    addMetric(stats, 'decisionRuns', 'modeledDecisions', optionalMetric(opportunity, [
      'user_decision_runs', 'user_value.fielding_decision_runs',
    ]))
    addMetric(stats, 'executionRuns', 'modeledExecutions', optionalMetric(opportunity, [
      'user_execution_runs', 'user_value.fielding_execution_runs',
    ]))
  }

  const mechanicPlays = new Map()
  for (const play of trackingPlays) {
    if (play?.quality?.quarantined_session === true) continue
    for (const mechanic of Array.isArray(play?.quality?.play_mechanics) ? play.quality.play_mechanics : []) {
      const id = identity === 'character' ? mechanic.actor?.characterId : mechanic.actor?.playerId
      const row = ensure(id)
      if (!row) continue
      const stats = row.fielding
      const key = `${play.id ?? `${play.competition_type}:${play.game_id}:${play.play_ordinal}`}:${mechanic.id ?? mechanic.type}`
      if (mechanicPlays.has(key)) continue
      mechanicPlays.set(key, true)
      if (mechanic.type === 'buddy_attack') {
        stats.actionAttempts += 1
        stats.buddyAttacks += 1
        if (mechanic.contact) stats.buddyAttackContacts += 1
        if (mechanic.cleared_object) stats.buddyObjectClears += 1
      } else if (mechanic.type === 'buddy_jump_attempt') {
        stats.actionAttempts += 1
        stats.buddyJumpAttempts += 1
      }
      addMetric(stats, 'decisionRuns', 'modeledDecisions', optionalMetric(mechanic, [
        'user_decision_runs', 'user_value.fielding_decision_runs',
      ]))
      addMetric(stats, 'executionRuns', 'modeledExecutions', optionalMetric(mechanic, [
        'user_execution_runs', 'user_value.fielding_execution_runs',
      ]))
    }
  }

  return [...rows.values()].map((row) => {
    const bat = row.batting, pitch = row.pitching, run = row.baserunning, field = row.fielding
    return {
      ...row,
      batting: {
        ...bat,
        userRuns: bat.modeledDecisions + bat.modeledExecutions ? bat.decisionRuns + bat.executionRuns : null,
        swingRate: bat.knownDecisions ? bat.swings / bat.knownDecisions : null,
        contactRate: bat.swings ? bat.contacts / bat.swings : null,
        decisionCoverage: bat.pitches ? bat.knownDecisions / bat.pitches : null,
        chargeCoverage: bat.swings ? (bat.slapSwings + bat.chargeSwings) / bat.swings : null,
        zoneCoverage: bat.pitches ? (bat.insideZonePitches + bat.outsideZonePitches) / bat.pitches : null,
        chaseRate: bat.outsideZonePitches ? bat.chases / bat.outsideZonePitches : null,
        chaseContactRate: bat.chases ? bat.chaseContacts / bat.chases : null,
        zoneSwingRate: bat.insideZonePitches ? bat.zoneSwings / bat.insideZonePitches : null,
      },
      pitching: {
        ...pitch,
        userRuns: pitch.modeledDecisions + pitch.modeledExecutions ? pitch.decisionRuns + pitch.executionRuns : null,
        inputCoverage: pitch.pitches ? pitch.inputObserved / pitch.pitches : null,
        aimCoverage: pitch.pitches ? pitch.aimObserved / pitch.pitches : null,
        chargeCoverage: pitch.pitches ? pitch.chargeObserved / pitch.pitches : null,
      },
      baserunning: {
        ...run,
        userRuns: run.modeledExecutions ? run.executionRuns : null,
        sprintSpeedFps: run.sprintSamples ? run.sprintSpeedTotal / run.sprintSamples : null,
        inputCoverage: run.sprintSamples ? run.shakeObserved / run.sprintSamples : null,
      },
      fielding: {
        ...field,
        userRuns: field.modeledDecisions + field.modeledExecutions ? field.decisionRuns + field.executionRuns : null,
        buddyContactRate: field.buddyAttacks ? field.buddyAttackContacts / field.buddyAttacks : null,
      },
    }
  })
}
