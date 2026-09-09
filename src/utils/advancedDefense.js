// Sluggers-native fielding and baserunning opportunity models.
//
// The database stores one row per opportunity. Everything in this module is
// deterministic from those rows so a model-version change can backfill history
// without replaying Dolphin. MLB definitions inspire the outputs, but the
// probabilities and run values are fitted to this league's environment.

export const ADVANCED_METRIC_VERSION = 'sluggers-advanced-v1'
export const METRES_TO_FEET = 3.280839895
export const MPS_TO_MPH = 2.2369362921

const BASE_BIT = { first: 1, second: 2, third: 4 }
const BASE_ORDER = { plate: 0, first: 1, second: 2, third: 3, home: 4, out: -1 }
const AIR_OUT_RESULTS = new Set(['FO', 'LO', 'SF'])
const GROUND_RESULTS = new Set(['GO', 'FC', 'DP', 'SH'])

function finite(value, fallback = null) {
  if (value == null || value === '') return fallback
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function clamp(value, low, high) {
  return Math.max(low, Math.min(high, value))
}

export function normalizeRunnerAssignments(value) {
  let rows = value
  if (typeof rows === 'string') {
    try { rows = JSON.parse(rows) } catch { return [] }
  }
  if (!Array.isArray(rows)) return []
  return rows.flatMap((row) => {
    const destination = row?.destination ?? row?.position
    if (!row?.id || !row?.runner || !['first', 'second', 'third', 'home', 'out'].includes(destination)) return []
    return [{
      id: String(row.id),
      runner: row.runner,
      origin: row.origin || null,
      destination,
      isBatter: Boolean(row.isBatter ?? row.is_batter ?? row.id === 'batter'),
      ...(['first', 'second', 'third', 'home'].includes(row.attemptedBase) ? { attemptedBase: row.attemptedBase } : {}),
    }]
  })
}

export function baseStateMask({ first = false, second = false, third = false } = {}) {
  return (first ? BASE_BIT.first : 0) | (second ? BASE_BIT.second : 0) | (third ? BASE_BIT.third : 0)
}

export function baseStateMaskFromPa(pa = {}) {
  return baseStateMask({
    first: Boolean(pa.runner_on_first_before),
    second: Boolean(pa.runner_on_second_before),
    third: Boolean(pa.runner_on_third_before),
  })
}

export function baseStateMaskFromAssignments(assignments = []) {
  return assignments.reduce((mask, row) => (
    row.destination in BASE_BIT ? mask | BASE_BIT[row.destination] : mask
  ), 0)
}

export function parseFieldingPositions(pa = {}) {
  const notation = String(pa.error_notation || pa.hit_notation || '')
  return (notation.split('-E')[0].match(/\d+/g) || [])
    .map(Number)
    .filter((position) => position >= 1 && position <= 9)
}

function paTrajectory(pa = {}) {
  const explicit = String(pa.trajectory || '').toUpperCase()
  if (explicit) return explicit
  if (AIR_OUT_RESULTS.has(pa.result)) return pa.result === 'LO' ? 'L' : 'F'
  if (GROUND_RESULTS.has(pa.result)) return pa.result === 'SH' ? 'B' : 'G'
  return null
}

export function isEligibleDoublePlayPa(pa = {}, outsBefore = 0) {
  if (finite(outsBefore, 0) >= 2 || !pa.runner_on_first_before) return false
  if (['K', 'BB', 'HBP', 'HR', 'IPHR', 'FO', 'LO', 'SF'].includes(pa.result)) return false
  const trajectory = paTrajectory(pa)
  return trajectory === 'G' || trajectory === 'B' || pa.result === 'DP'
}

export function buildDoublePlayOpportunityFromPa(pa = {}, {
  competitionType = 'tournament',
  outsBefore = 0,
  firstFielder = null,
  pivotFielder = null,
} = {}) {
  if (!isEligibleDoublePlayPa(pa, outsBefore)) return null
  const actualOuts = clamp(Math.trunc(finite(pa.outs_on_play, pa.result === 'DP' ? 2 : 0)), 0, 3)
  return {
    competition_type: competitionType,
    game_id: pa.game_id,
    pa_id: pa.id,
    outs_before: Math.trunc(finite(outsBefore, 0)),
    base_state_before: baseStateMaskFromPa(pa),
    trajectory: paTrajectory(pa),
    structural_eligible: true,
    actual_outs: actualOuts,
    double_play_completed: actualOuts >= 2 || pa.result === 'DP',
    first_fielder_player_id: firstFielder?.playerId || firstFielder?.player_id || null,
    first_fielder_character_id: finite(firstFielder?.characterId ?? firstFielder?.character_id),
    first_fielder_position: firstFielder?.position ? String(firstFielder.position) : null,
    pivot_fielder_player_id: pivotFielder?.playerId || pivotFielder?.player_id || null,
    pivot_fielder_character_id: finite(pivotFielder?.characterId ?? pivotFielder?.character_id),
    pivot_fielder_position: pivotFielder?.position ? String(pivotFielder.position) : null,
    credit_status: firstFielder ? 'team' : 'unresolved',
    model_version: null,
    context: {
      result: pa.result || null,
      exit_velocity_mph: finite(pa.exit_velocity_mph),
      hit_world_x: finite(pa.hit_world_x),
      hit_world_z: finite(pa.hit_world_z),
      fielded_x: finite(pa.fielded_x),
      fielded_y: finite(pa.fielded_y),
      positions: parseFieldingPositions(pa),
    },
  }
}

function extraBaseSpecs(pa = {}) {
  if (pa.is_error || pa.result === 'ROE') return []
  if (pa.result === '1B') return [
    { runnerId: 'first', origin: 'first', target: 'third', type: 'first_to_third_on_single' },
    { runnerId: 'second', origin: 'second', target: 'home', type: 'second_to_home_on_single' },
  ]
  if (pa.result === '2B') return [
    { runnerId: 'first', origin: 'first', target: 'home', type: 'first_to_home_on_double' },
  ]
  if (AIR_OUT_RESULTS.has(pa.result)) return [
    { runnerId: 'first', origin: 'first', target: 'second', type: 'tag_first_to_second' },
    { runnerId: 'second', origin: 'second', target: 'third', type: 'tag_second_to_third' },
    { runnerId: 'third', origin: 'third', target: 'home', type: 'tag_third_to_home' },
  ]
  return []
}

function runnerIds(row = {}) {
  return {
    playerId: row.runner?.playerId ?? row.runner?.player_id ?? null,
    characterId: finite(row.runner?.characterId ?? row.runner?.character_id),
  }
}

export function buildExtraBaseOpportunitiesFromPa(pa = {}, {
  competitionType = 'tournament',
  outsBefore = 0,
  responsibleFielder = null,
} = {}) {
  const assignments = normalizeRunnerAssignments(pa.runner_assignments)
  if (!assignments.length) return []
  const assignmentById = new Map(assignments.map((row) => [row.id, row]))
  const expectedIds = ['batter', ...['first', 'second', 'third'].filter((base) => pa[`runner_on_${base}_before`])]
  if (expectedIds.some((id) => !assignmentById.has(id))) return []
  const outsOnPlay = clamp(Math.trunc(finite(pa.outs_on_play, 0)), 0, 3)
  const afterMask = baseStateMaskFromAssignments(assignments)
  // There is no tag-up decision after a catch records the third out.
  // A doubled-off runner on a caught ball is not an extra-base attempt.
  if (AIR_OUT_RESULTS.has(pa.result) && (outsBefore >= 2 || outsOnPlay > 1)) return []

  return extraBaseSpecs(pa).flatMap((spec) => {
    const assignment = assignmentById.get(spec.runnerId)
    if (!assignment || assignment.isBatter) return []
    if (!pa[`runner_on_${spec.origin}_before`]) return []
    if (assignment.origin && assignment.origin !== spec.origin) return []
    const ids = runnerIds(assignment)
    if (ids.playerId == null && ids.characterId == null) return []
    const targetOccupied = assignments.some((row) => (
      row.id !== spec.runnerId
      && !row.isBatter
      && row.destination === spec.target
    ))
    if (targetOccupied) return []
    const actualRank = BASE_ORDER[assignment.destination] ?? -1
    const targetRank = BASE_ORDER[spec.target]
    let outcome
    if (assignment.destination === 'out') {
      // Being retired before reaching the guaranteed base on a hit, or
      // doubled off after a catch, cannot be charged as a failed extra base.
      if (assignment.attemptedBase !== spec.target) return []
      outcome = 'advance_out'
    }
    else if (actualRank >= targetRank) outcome = 'advance_safe'
    else outcome = 'hold'
    if (outcome === 'hold' && outsBefore + outsOnPlay >= 3) return []
    return [{
      competition_type: competitionType,
      game_id: pa.game_id,
      pa_id: pa.id,
      runner_id: spec.runnerId,
      runner_player_id: ids.playerId,
      runner_character_id: ids.characterId,
      origin_base: spec.origin,
      target_base: spec.target,
      opportunity_type: spec.type,
      outcome,
      is_discretionary: true,
      attempted: outcome !== 'hold',
      safe: outcome === 'advance_safe' ? true : outcome === 'advance_out' ? false : null,
      responsible_fielder_player_id: responsibleFielder?.playerId || responsibleFielder?.player_id || null,
      responsible_fielder_character_id: finite(responsibleFielder?.characterId ?? responsibleFielder?.character_id),
      responsible_fielder_position: responsibleFielder?.position ? String(responsibleFielder.position) : null,
      outs_before: Math.trunc(finite(outsBefore, 0)),
      outs_after: Math.min(3, Math.trunc(finite(outsBefore, 0)) + outsOnPlay),
      base_state_before: baseStateMaskFromPa(pa),
      base_state_after: afterMask,
      model_version: null,
      quality: { result: pa.result || null, destination: assignment.destination },
    }]
  })
}

function betaMean(successes, attempts, priorMean, priorStrength) {
  return (successes + priorMean * priorStrength) / (attempts + priorStrength)
}

function rowContextKey(row = {}) {
  return [row.opportunity_type, finite(row.outs_before, 0), row.origin_base, row.target_base].join('|')
}

function dpContextKey(row = {}) {
  const context = row.context || {}
  const ev = finite(context.exit_velocity_mph)
  const evBucket = ev == null ? 'na' : Math.floor(ev / 10) * 10
  return [row.trajectory || 'G', finite(row.outs_before, 0), row.base_state_before || 0, evBucket].join('|')
}

export function buildRunExpectancy(plateAppearances = []) {
  const groups = new Map()
  for (const pa of plateAppearances) {
    const halfKey = `${pa.competition_type || pa.source_type || 'tournament'}:${pa.game_id}:${pa.inning || 1}:${pa.batting_team_id || pa.player_id || 'unknown'}`
    if (!groups.has(halfKey)) groups.set(halfKey, [])
    groups.get(halfKey).push(pa)
  }

  const samples = new Map()
  for (const rows of groups.values()) {
    rows.sort((a, b) => finite(a.pa_number, 0) - finite(b.pa_number, 0))
    const runs = rows.map((pa) => {
      const assignments = normalizeRunnerAssignments(pa.runner_assignments)
      const assignmentRuns = assignments.filter((row) => row.destination === 'home').length
      return assignmentRuns || Math.max(finite(pa.rbi, 0), pa.run_scored ? 1 : 0)
    })
    let futureRuns = runs.reduce((sum, value) => sum + value, 0)
    let outs = 0
    rows.forEach((pa, index) => {
      const key = `${Math.min(2, outs)}:${baseStateMaskFromPa(pa)}`
      if (!samples.has(key)) samples.set(key, [])
      samples.get(key).push(futureRuns)
      futureRuns -= runs[index]
      outs += clamp(Math.trunc(finite(pa.outs_on_play, 0)), 0, 3)
    })
  }
  const expectancy = new Map([['3:0', 0]])
  for (const [key, values] of samples) {
    expectancy.set(key, values.reduce((sum, value) => sum + value, 0) / values.length)
  }
  return expectancy
}

function fallbackStateValue(outs, mask) {
  if (outs >= 3) return 0
  const base = ((mask & 1) ? 0.25 : 0) + ((mask & 2) ? 0.42 : 0) + ((mask & 4) ? 0.62 : 0)
  return base + [0.45, 0.25, 0.1][outs]
}

export function runExpectancyValue(expectancy, outs, mask) {
  const safeOuts = clamp(Math.trunc(finite(outs, 0)), 0, 3)
  const safeMask = clamp(Math.trunc(finite(mask, 0)), 0, 7)
  return expectancy?.get?.(`${safeOuts}:${safeMask}`) ?? fallbackStateValue(safeOuts, safeMask)
}

function moveRunnerMask(mask, origin, target) {
  let next = mask & ~BASE_BIT[origin]
  if (target in BASE_BIT) next |= BASE_BIT[target]
  return next
}

function opportunityOutcomeValues(row, expectancy) {
  const outs = clamp(Math.trunc(finite(row.outs_before, 0)), 0, 2)
  const mask = clamp(Math.trunc(finite(row.base_state_before, 0)), 0, 7)
  const before = runExpectancyValue(expectancy, outs, mask)
  const safeMask = moveRunnerMask(mask, row.origin_base, row.target_base)
  const safeRuns = row.target_base === 'home' ? 1 : 0
  const safeValue = safeRuns + runExpectancyValue(expectancy, outs, safeMask) - before
  const outMask = mask & ~BASE_BIT[row.origin_base]
  const outValue = runExpectancyValue(expectancy, outs + 1, outMask) - before
  return { safeValue, outValue }
}

export function modelRunnerOpportunities(rows = [], expectancy = new Map()) {
  const eligible = rows.filter((row) => row.is_discretionary !== false && ['hold', 'advance_safe', 'advance_out'].includes(row.outcome))
  const globalAttempts = eligible.filter((row) => row.attempted).length
  const globalAttemptRate = eligible.length ? globalAttempts / eligible.length : 0.35
  const attempted = eligible.filter((row) => row.attempted)
  const globalSuccessRate = attempted.length ? attempted.filter((row) => row.safe).length / attempted.length : 0.7
  const byContext = new Map()
  for (const row of eligible) {
    const key = rowContextKey(row)
    const entry = byContext.get(key) || { n: 0, attempts: 0, safe: 0 }
    entry.n += 1
    if (row.attempted) {
      entry.attempts += 1
      if (row.safe) entry.safe += 1
    }
    byContext.set(key, entry)
  }

  return rows.map((row) => {
    if (!eligible.includes(row)) return { ...row }
    const bucket = byContext.get(rowContextKey(row))
    // Leave the current outcome out of its own expectation, then shrink hard
    // while the league is small. This prevents one attempt defining itself.
    const n = Math.max(0, bucket.n - 1)
    const attempts = Math.max(0, bucket.attempts - (row.attempted ? 1 : 0))
    const safe = Math.max(0, bucket.safe - (row.attempted && row.safe ? 1 : 0))
    const expectedAttempt = betaMean(attempts, n, globalAttemptRate, 12)
    const successTrials = attempts
    const expectedSuccess = betaMean(safe, successTrials, globalSuccessRate, 10)
    const { safeValue, outValue } = opportunityOutcomeValues(row, expectancy)
    const expectedValue = expectedAttempt * (expectedSuccess * safeValue + (1 - expectedSuccess) * outValue)
    const actualValue = row.outcome === 'advance_safe' ? safeValue : row.outcome === 'advance_out' ? outValue : 0
    return {
      ...row,
      expected_attempt_probability: expectedAttempt,
      expected_success_probability: expectedSuccess,
      runner_run_value: actualValue - expectedValue,
      arm_run_value: row.responsible_fielder_character_id != null ? expectedValue - actualValue : null,
      model_version: ADVANCED_METRIC_VERSION,
    }
  })
}

export function modelDoublePlayOpportunities(rows = [], expectancy = new Map()) {
  const eligible = rows.filter((row) => row.structural_eligible !== false)
  const globalRate = eligible.length
    ? eligible.filter((row) => row.double_play_completed).length / eligible.length
    : 0.25
  const byContext = new Map()
  for (const row of eligible) {
    const key = dpContextKey(row)
    const entry = byContext.get(key) || { n: 0, completed: 0 }
    entry.n += 1
    if (row.double_play_completed) entry.completed += 1
    byContext.set(key, entry)
  }
  return rows.map((row) => {
    if (!eligible.includes(row)) return { ...row }
    const bucket = byContext.get(dpContextKey(row))
    const n = Math.max(0, bucket.n - 1)
    const completed = Math.max(0, bucket.completed - (row.double_play_completed ? 1 : 0))
    const expected = betaMean(completed, n, globalRate, 15)
    const added = (row.double_play_completed ? 1 : 0) - expected
    const outs = clamp(Math.trunc(finite(row.outs_before, 0)), 0, 1)
    const mask = clamp(Math.trunc(finite(row.base_state_before, 0)), 0, 7)
    const oneOutState = runExpectancyValue(expectancy, outs + 1, mask & ~BASE_BIT.first)
    const twoOutState = runExpectancyValue(expectancy, outs + 2, mask & ~BASE_BIT.first)
    const secondOutRuns = Math.max(0.1, oneOutState - twoOutState)
    return {
      ...row,
      expected_double_play_probability: expected,
      double_plays_added: added,
      run_value: added * secondOutRuns,
      model_version: ADVANCED_METRIC_VERSION,
    }
  })
}

function fieldingBucket(row = {}) {
  const distance = finite(row.distance_needed_m)
  const time = finite(row.opportunity_seconds)
  const distanceBucket = distance == null ? 'na' : Math.floor(distance / 5) * 5
  const timeBucket = time == null ? 'na' : Math.floor(time * 2) / 2
  return `${row.position || 'unknown'}|${distanceBucket}|${timeBucket}`
}

export function catchProbabilityStar(probability) {
  if (!Number.isFinite(probability)) return null
  if (probability <= 0.10) return 5
  if (probability <= 0.25) return 4
  if (probability <= 0.50) return 3
  if (probability <= 0.75) return 2
  return 1
}

export function modelFieldingOpportunities(rows = []) {
  const eligible = rows.filter((row) => (
    row.is_primary
    && row.actual_out != null
    && finite(row.distance_needed_m) != null
    && finite(row.opportunity_seconds) != null
    && row.quality?.exclude_from_oaa !== true
    && row.quality?.quarantined_session !== true
  ))
  const byPosition = new Map()
  const byBucket = new Map()
  for (const row of eligible) {
    const position = String(row.position || 'unknown')
    const pos = byPosition.get(position) || { n: 0, outs: 0 }
    pos.n += 1
    if (row.actual_out) pos.outs += 1
    byPosition.set(position, pos)
    const key = fieldingBucket(row)
    const bucket = byBucket.get(key) || { n: 0, outs: 0 }
    bucket.n += 1
    if (row.actual_out) bucket.outs += 1
    byBucket.set(key, bucket)
  }
  return rows.map((row) => {
    if (!eligible.includes(row)) return { ...row }
    const position = byPosition.get(String(row.position || 'unknown')) || { n: 0, outs: 0 }
    const positionRate = position.n ? position.outs / position.n : 0.5
    const bucket = byBucket.get(fieldingBucket(row))
    const n = Math.max(0, bucket.n - 1)
    const outs = Math.max(0, bucket.outs - (row.actual_out ? 1 : 0))
    const expected = betaMean(outs, n, positionRate, 12)
    return {
      ...row,
      expected_out_probability: expected,
      outs_above_average: (row.actual_out ? 1 : 0) - expected,
      star_difficulty: catchProbabilityStar(expected),
      model_version: ADVANCED_METRIC_VERSION,
    }
  })
}

function hardestThrowShare(position) {
  if (position === '1B') return 0.01
  if (['2B', '3B', 'SS'].includes(position)) return 0.05
  return 0.10
}

// A Buddy Throw is two chemistry-linked fielders combining: the first dashes and
// bounces the ball to the second, who fires it in. It is not one player's arm,
// and it is not even clear from the capture whose arm it is -- the game freezes
// every actor for the cutscene, so the partner who releases the ball never
// appears in the position data. On the first real session the only two Buddy
// Throws were also the only two above 122 mph, at 182 and 208 against a normal
// spread of 79 to 123. Counting them would rank fielders by their chemistry
// pairings rather than by their arms, so they are held apart.
export function aggregateArmStrength(throws = []) {
  const valid = throws.filter((row) => (
    finite(row.peak_speed_mph) != null && row.quality?.quarantined_session !== true
  ))
  const buddy = valid.filter((row) => row.is_buddy_throw === true)
  const normal = valid.filter((row) => row.is_buddy_throw !== true)
  const empty = {
    throws: valid.length,
    armStrengthMph: null,
    hardestThrowMph: null,
    buddyThrows: buddy.length,
    hardestBuddyThrowMph: buddy.length
      ? Math.max(...buddy.map((row) => finite(row.peak_speed_mph)))
      : null,
  }
  if (!normal.length) return empty
  const byPosition = new Map()
  normal.forEach((row) => {
    const key = row.thrower_position || 'unknown'
    if (!byPosition.has(key)) byPosition.set(key, [])
    byPosition.get(key).push(finite(row.peak_speed_mph))
  })
  const qualifying = []
  for (const [position, speeds] of byPosition) {
    speeds.sort((a, b) => b - a)
    const count = Math.max(1, Math.ceil(speeds.length * hardestThrowShare(position)))
    qualifying.push(...speeds.slice(0, count))
  }
  return {
    ...empty,
    armStrengthMph: qualifying.reduce((sum, value) => sum + value, 0) / qualifying.length,
    hardestThrowMph: Math.max(...normal.map((row) => finite(row.peak_speed_mph))),
  }
}

function groupRows(rows, key) {
  const groups = new Map()
  for (const row of rows) {
    const value = row?.[key]
    if (value == null) continue
    const normalized = String(value)
    if (!groups.has(normalized)) groups.set(normalized, [])
    groups.get(normalized).push(row)
  }
  return groups
}

export function summarizeAdvancedFielding({
  throws = [], runnerOpportunities = [], doublePlayOpportunities = [], fieldingOpportunities = [],
} = {}, identity = 'character') {
  const keySuffix = identity === 'player' ? 'player_id' : 'character_id'
  const throwKey = `thrower_${keySuffix}`
  const armKey = `responsible_fielder_${keySuffix}`
  const dpKey = `first_fielder_${keySuffix}`
  const fieldKey = `fielder_${keySuffix}`
  const groupedThrows = groupRows(throws, throwKey)
  const groupedArm = groupRows(runnerOpportunities, armKey)
  const groupedDp = groupRows(doublePlayOpportunities, dpKey)
  const groupedField = groupRows(fieldingOpportunities, fieldKey)
  const ids = new Set([...groupedThrows.keys(), ...groupedArm.keys(), ...groupedDp.keys(), ...groupedField.keys()])
  return Object.fromEntries([...ids].map((id) => {
    const arm = groupedArm.get(id) || []
    // v1 DP responsibility is team-level. `player` identity represents the
    // team owner in Sluggers and may consume those rows; character leaderboards
    // wait until a later detector explicitly promotes credit_status to player.
    const dp = (groupedDp.get(id) || []).filter((row) => (
      identity === 'player' || row.credit_status === 'player'
    ))
    const allField = (groupedField.get(id) || []).filter((row) => row.quality?.quarantined_session !== true)
    const field = allField.filter((row) => row.is_primary && finite(row.outs_above_average) != null)
    const positioned = allField.filter((row) => finite(row.position_depth_ft) != null)
    const strength = aggregateArmStrength(groupedThrows.get(id) || [])
    const armValue = arm.reduce((sum, row) => sum + finite(row.arm_run_value, 0), 0)
    const dpRuns = dp.reduce((sum, row) => sum + finite(row.run_value, 0), 0)
    const oaa = field.reduce((sum, row) => sum + finite(row.outs_above_average, 0), 0)
    const directionalOaa = Object.fromEntries(
      ['back_left', 'back', 'back_right', 'in_left', 'in', 'in_right'].map((direction) => [
        direction,
        field.filter((row) => row.direction === direction)
          .reduce((sum, row) => sum + finite(row.outs_above_average, 0), 0),
      ]),
    )
    const directionalOpportunities = Object.fromEntries(
      ['back_left', 'back', 'back_right', 'in_left', 'in', 'in_right'].map((direction) => [
        direction,
        field.filter((row) => row.direction === direction).length,
      ]),
    )
    return [id, {
      ...strength,
      armOpportunities: arm.length,
      armHolds: arm.filter((row) => row.outcome === 'hold').length,
      armAdvances: arm.filter((row) => row.outcome === 'advance_safe').length,
      armKills: arm.filter((row) => row.outcome === 'advance_out').length,
      armValue,
      doublePlayOpportunities: dp.length,
      doublePlays: dp.filter((row) => row.double_play_completed).length,
      doublePlaysAdded: dp.reduce((sum, row) => sum + finite(row.double_plays_added, 0), 0),
      doublePlayRuns: dpRuns,
      fieldingOpportunities: field.length,
      actualOuts: field.filter((row) => row.actual_out).length,
      expectedOuts: field.reduce((sum, row) => sum + finite(row.expected_out_probability, 0), 0),
      outsAboveAverage: oaa,
      directionalOaa,
      directionalOpportunities,
      positioningSamples: positioned.length,
      averagePositionDepthFeet: positioned.length
        ? positioned.reduce((sum, row) => sum + finite(row.position_depth_ft, 0), 0) / positioned.length
        : null,
      averagePositionAngleDeg: positioned.length
        ? positioned.reduce((sum, row) => sum + finite(row.position_angle_deg, 0), 0) / positioned.length
        : null,
      fieldingRunValue: oaa * 0.8 + armValue + dpRuns,
    }]
  }))
}

export function summarizeAdvancedBaserunning(rows = [], identity = 'character') {
  const key = identity === 'player' ? 'runner_player_id' : 'runner_character_id'
  return Object.fromEntries([...groupRows(rows, key)].map(([id, opportunities]) => [id, {
    opportunities: opportunities.length,
    attempts: opportunities.filter((row) => row.attempted).length,
    holds: opportunities.filter((row) => row.outcome === 'hold').length,
    advances: opportunities.filter((row) => row.outcome === 'advance_safe').length,
    outs: opportunities.filter((row) => row.outcome === 'advance_out').length,
    attemptRate: opportunities.length
      ? opportunities.filter((row) => row.attempted).length / opportunities.length
      : null,
    successRate: opportunities.some((row) => row.attempted)
      ? opportunities.filter((row) => row.outcome === 'advance_safe').length / opportunities.filter((row) => row.attempted).length
      : null,
    modeledOpportunities: opportunities.filter((row) => finite(row.runner_run_value) != null).length,
    baserunningRunValue: opportunities.some((row) => finite(row.runner_run_value) != null)
      ? opportunities.reduce((sum, row) => sum + finite(row.runner_run_value, 0), 0) : null,
  }]))
}

export const MIN_QUALIFYING_RUN_UNITS = 15

export function summarizeMovementMetrics(rows = [], identity = 'character') {
  const key = identity === 'player' ? 'player_id' : 'character_id'
  const usableRows = rows.filter((row) => row.quality?.quarantined_session !== true)
  return Object.fromEntries([...groupRows(usableRows, key)].map(([id, samples]) => {
    // A run has to be long enough for the character to reach top speed before
    // it says anything about how fast they are. Measured against the game's own
    // run_speed attribute, the qualifying distance is most of the metric: this
    // estimator correlates at 0.69 admitting every run over 1 unit and 0.72
    // over 15. It keeps climbing to 0.78 at 20 units, but the characters that
    // qualify drop from 31 to 24, which is a worse trade at the sample sizes
    // this league has.
    //
    // Only runner and batter rows, deliberately. A FIELDER's per-play speed is
    // context for a range model, not a rating -- see the note in
    // scripts/ingest_player_tracking.mjs.
    const running = samples.filter((row) => (
      ['runner', 'batter'].includes(row.actor_type)
      && finite(row.sprint_speed_fps) > 0
      && (finite(row.path_distance_m) == null
        || finite(row.path_distance_m) >= MIN_QUALIFYING_RUN_UNITS)
    ))
    const competitive = [...running].sort((a, b) => finite(b.sprint_speed_fps, 0) - finite(a.sprint_speed_fps, 0))
    const qualifying = competitive.slice(0, Math.max(1, Math.ceil(competitive.length * 2 / 3)))
    const homeToFirst = samples.filter((row) => finite(row.home_to_first_seconds) != null)
    const ninety = samples.filter((row) => finite(row.ninety_foot_split_seconds) != null)
    const jump = samples.filter((row) => row.actor_type === 'fielder' && finite(row.jump_distance_feet) != null)
    const average = (source, accessor) => source.length
      ? source.reduce((sum, row) => sum + finite(accessor(row), 0), 0) / source.length
      : null
    return [id, {
      speedSamples: running.length,
      sprintSpeedFps: average(qualifying, (row) => row.sprint_speed_fps),
      maxSprintSpeedFps: running.length ? Math.max(...running.map((row) => finite(row.sprint_speed_fps, 0))) : null,
      bolts: running.filter((row) => row.is_bolt).length,
      homeToFirstSamples: homeToFirst.length,
      homeToFirstSeconds: average(homeToFirst, (row) => row.home_to_first_seconds),
      ninetyFootSplitSeconds: average(ninety, (row) => row.ninety_foot_split_seconds),
      jumpSamples: jump.length,
      jumpDistanceFeet: average(jump, (row) => row.jump_distance_feet),
      jumpReactionFeet: average(jump, (row) => row.reaction_distance_feet),
      jumpBurstFeet: average(jump, (row) => row.burst_distance_feet),
      jumpRouteEfficiency: average(jump.filter((row) => finite(row.jump_route_efficiency) != null), (row) => row.jump_route_efficiency),
    }]
  }))
}
