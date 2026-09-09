import { getForcedRunnerIds } from './forcePlay.js'

// ─── Runner logic ─────────────────────────────────────────────────────────────
// Extracted from Scorebook.jsx's live-entry "runner placement" engine so the
// tracker at-bat editor can drive the same result → default-runner-movement
// predictions and the same manual-nudge adjustment rules, instead of a second
// reimplementation drifting from the live scoring one.
//
// Each runner: { characterId, playerId }
// pendingPA assignments: [{ id, runner, origin, destination, isBatter }]

export const HIT_RESULTS = new Set(['1B', '2B', '3B', 'HR', 'IPHR'])
export const NEEDS_RESOLUTION = new Set(['1B', '2B', '3B'])
export const IN_PLAY_OUT_OPTIONS = ['GO', 'FO', 'LO', 'SF', 'SH']

export function buildPendingAssignment(id, runner, origin, destination, isBatter = false) {
  return { id, runner, origin, destination, isBatter }
}

export function computePendingState(result, runners, batter) {
  const { first, second, third } = runners
  const assignments = []
  const push = (id, runner, origin, destination, isBatter = false) => {
    if (!runner) return
    assignments.push(buildPendingAssignment(id, runner, origin, destination, isBatter))
  }

  const pushForcedFirstBaseAdvances = () => {
    if (first && second && third) {
      push('first', first, 'first', 'second')
      push('second', second, 'second', 'third')
      push('third', third, 'third', 'home')
    } else if (first && second) {
      push('first', first, 'first', 'second')
      push('second', second, 'second', 'third')
    } else if (first) {
      push('first', first, 'first', 'second')
      push('third', third, 'third', 'third')
    } else {
      push('second', second, 'second', 'second')
      push('third', third, 'third', 'third')
    }
  }

  const pushOneBaseErrorAdvance = () => {
    push('first', first, 'first', 'second')
    push('second', second, 'second', 'third')
    push('third', third, 'third', 'home')
  }

  switch (result) {
    case '1B':
      push('batter', batter, 'plate', 'first', true)
      push('first', first, 'first', 'second')
      push('second', second, 'second', 'third')
      push('third', third, 'third', 'home')
      return { result, assignments }
    case '2B':
      push('batter', batter, 'plate', 'second', true)
      push('first', first, 'first', 'third')
      push('second', second, 'second', 'home')
      push('third', third, 'third', 'home')
      return { result, assignments }
    case '3B':
      push('batter', batter, 'plate', 'third', true)
      push('first', first, 'first', 'home')
      push('second', second, 'second', 'home')
      push('third', third, 'third', 'home')
      return { result, assignments }
    case 'BB':
    case 'HBP':
      push('batter', batter, 'plate', 'first', true)
      pushForcedFirstBaseAdvances()
      return { result, assignments }
    case 'ROE':
      push('batter', batter, 'plate', 'first', true)
      pushOneBaseErrorAdvance()
      return { result, assignments }
    default:
      return { result, assignments: [] }
  }
}

export function getRbiFromAssignments(assignments) {
  return assignments.filter((assignment) => assignment.destination === 'home' && !assignment.isBatter).length
}

// Mirror normalizeRbiForPaResult: DP/TP credit no RBI at save time either, so
// the confirm preview must not show one when a runner scores on a double play.
export function getPreviewRbiFromAssignments(result, assignments) {
  if (result === 'ROE' || result === 'FC' || result === 'DP' || result === 'TP') return 0
  const runnerRbi = getRbiFromAssignments(assignments)
  const batterScoresOnHit = HIT_RESULTS.has(result) && assignments.some((assignment) => assignment.isBatter && assignment.destination === 'home')
  return runnerRbi + (batterScoresOnHit ? 1 : 0)
}

export function didBatterScore(assignments) {
  return assignments.some((assignment) => assignment.isBatter && assignment.destination === 'home')
}

// True when the only thing the runner-assignment panel would show is the
// batter going to the one base their hit type guarantees (bases empty, no
// runner to adjust) — nothing for the scorer to actually decide.
export function isTrivialPendingResolution({ assignments }) {
  return assignments.length === 1 && assignments[0].isBatter
}

export function extractNextRunners({ assignments }) {
  return assignments.reduce((next, assignment) => {
    if (assignment.destination === 'first') next.first = assignment.runner
    if (assignment.destination === 'second') next.second = assignment.runner
    if (assignment.destination === 'third') next.third = assignment.runner
    return next
  }, { first: null, second: null, third: null })
}

export function getHomeAssignments({ assignments }) {
  return assignments.filter((assignment) => assignment.destination === 'home')
}

export function getOutAssignments({ assignments }) {
  return assignments.filter((assignment) => assignment.destination === 'out')
}

// The runner-placement screen only records *that* a runner was thrown out
// advancing during a hit (e.g. caught at the plate trying to score on a
// double) — not which fielder covered the base. That's safely implied: the
// base they were headed to when marked out has one conventional covering
// fielder, who becomes the real putout, with whoever touched the ball
// (fielderChain) credited an assist instead — same as a real "7-2" (or,
// with a cutoff man also tapped, "7-8-2") notation. Second base is the one
// genuinely ambiguous case (2B or SS can both cover); SS is the more common
// default.
export const BASE_COVERING_POSITION = { first: 3, second: 6, third: 5, home: 2 }

export function pendingLeavesRunnersOnBase(pending) {
  return hasAnyActiveRunners(extractNextRunners(pending))
}

export function hasAnyActiveRunners(runners = {}) {
  return Boolean(runners.first || runners.second || runners.third)
}

export function normalizeLiveRunner(runner = null) {
  if (!runner || runner.characterId == null || runner.playerId == null) return null
  // Preserve reachedOnError/chargedToPitcher* alongside the id fields — these
  // decide earned-run status and pitcher-of-record when this runner eventually
  // scores. Dropping them here (as this used to) meant a runner who reached on
  // an error looked "clean" again the moment live_state was read back on a
  // fresh session, silently turning a should-be-unearned run earned.
  return {
    characterId: Number(runner.characterId),
    playerId: runner.playerId,
    ...(runner.reachedOnError ? { reachedOnError: true } : {}),
    ...(runner.chargedToPitcherId != null ? { chargedToPitcherId: runner.chargedToPitcherId } : {}),
    ...(runner.chargedToPitcherPlayerId != null ? { chargedToPitcherPlayerId: runner.chargedToPitcherPlayerId } : {}),
  }
}

export function normalizeLiveRunners(runners = {}) {
  return {
    first: normalizeLiveRunner(runners.first),
    second: normalizeLiveRunner(runners.second),
    third: normalizeLiveRunner(runners.third),
  }
}

export function getNextBase(baseKey) {
  if (baseKey === 'first') return 'second'
  if (baseKey === 'second') return 'third'
  if (baseKey === 'third') return 'home'
  return baseKey
}

export function getLeadForcedRunnerId(runners = {}) {
  if (runners.first && runners.second && runners.third) return 'third'
  if (runners.first && runners.second) return 'second'
  if (runners.first) return 'first'
  return null
}

export function mapPositionToForcedBase(position) {
  const normalized = String(position || '')
  if (normalized === '2') return 'home'
  if (normalized === '5') return 'third'
  if (normalized === '4' || normalized === '6') return 'second'
  if (normalized === '1' || normalized === '3') return 'first'
  return null
}

export function inferLikelyForcedOutId(putoutPosition, runners = {}) {
  const position = String(putoutPosition || '')
  if ((position === '4' || position === '6') && runners.first) return 'first'
  if (position === '5' && runners.first && runners.second) return 'second'
  if (position === '2' && runners.first && runners.second && runners.third) return 'third'
  if (position === '1' || position === '3') return 'batter'
  return null
}

export function shouldResolveOutAssignments(result, runners = {}) {
  return hasAnyActiveRunners(runners) && ['GO', 'FO', 'LO', 'SF', 'SH', 'DP'].includes(result)
}

export function computePendingOutState(result, runners, batter, {
  primaryPosition = null,
  fielderChain = [],
} = {}) {
  const { first, second, third } = runners
  const assignments = []
  const push = (id, runner, origin, destination, isBatter = false) => {
    if (!runner) return
    assignments.push(buildPendingAssignment(id, runner, origin, destination, isBatter))
  }

  const putoutPosition = Array.isArray(fielderChain) && fielderChain.length
    ? fielderChain[fielderChain.length - 1]
    : primaryPosition
  const inferredOutId = inferLikelyForcedOutId(putoutPosition, runners)
  const fallbackForcedOutId = getLeadForcedRunnerId(runners)
  const resolvedRunnerOutId = inferredOutId && (result !== 'FC' || inferredOutId !== 'batter')
    ? inferredOutId
    : fallbackForcedOutId
  const touchedBases = (Array.isArray(fielderChain) ? fielderChain.slice(1) : [])
    .map(mapPositionToForcedBase)
    .filter(Boolean)
  const outIds = []
  let batterStillForced = true
  let firstStillOccupied = Boolean(first)
  let secondStillOccupied = Boolean(second)
  let thirdStillOccupied = Boolean(third)
  for (const touchedBase of touchedBases) {
    // A throw to third or home retires whoever's standing on the base behind
    // it — that's true whether they were forced (bases loaded) or just
    // advancing on their own read (e.g. a runner on 2nd only, thrown out at
    // third on a 6-5). Only the batter's own advancement is force-gated,
    // since the batter is always obligated to run.
    if (touchedBase === 'home' && thirdStillOccupied) {
      outIds.push('third')
      thirdStillOccupied = false
      continue
    }
    if (touchedBase === 'third' && secondStillOccupied) {
      outIds.push('second')
      secondStillOccupied = false
      continue
    }
    if (touchedBase === 'second' && firstStillOccupied && batterStillForced) {
      outIds.push('first')
      firstStillOccupied = false
      continue
    }
    if (touchedBase === 'first' && batterStillForced) {
      outIds.push('batter')
      batterStillForced = false
    }
  }
  if (!outIds.length && resolvedRunnerOutId) outIds.push(resolvedRunnerOutId)
  const outIdSet = new Set(outIds)
  const isGrounderChoice = result === 'FC' || result === 'DP' || (result === 'GO' && (outIdSet.size > 0 || (resolvedRunnerOutId && inferredOutId !== 'batter')))
  const batterOut = result === 'SF' || result === 'SH' || (!isGrounderChoice && result !== 'FC')
  const forcedAtStart = {
    first: Boolean(first),
    second: Boolean(first && second),
    third: Boolean(first && second && third),
  }

  const batterSafe = !outIdSet.has('batter') && !batterOut
  if (!batterSafe) {
    push('batter', batter, 'plate', 'out', true)
  } else {
    push('batter', batter, 'plate', 'first', true)
  }

  // A runner on first is forced to vacate the base the instant the ball is
  // hit on the ground, regardless of whether the batter-runner ends up safe
  // or out at first — so advancement here must not be gated on batterSafe
  // (that previously left a forced runner stranded at first on an ordinary
  // 6-3/5-3 groundout instead of advancing them to second).
  const firstAdvances = Boolean(first && !outIdSet.has('first'))
  const secondAdvances = Boolean(second && !outIdSet.has('second') && firstAdvances)
  const thirdAdvances = Boolean(third && !outIdSet.has('third') && secondAdvances)

  const defaultRunnerDestination = (baseKey) => {
    if (result === 'SF') {
      return baseKey === 'third' ? 'home' : baseKey
    }
    if (result === 'SH') {
      return getNextBase(baseKey)
    }
    if (result === 'FO' || result === 'LO') {
      // A fielder touch after the catch (e.g. the outfielder who caught a
      // leaping liner throwing back to second) means a runner left before
      // the tag-up completed and was thrown out — the throw goes back to
      // the base the runner started on, or to the plate for a runner
      // trying to score from third. Default to that runner being out
      // rather than assuming everyone safely stayed put.
      const isTaggedOut = baseKey === 'third'
        ? touchedBases.includes('third') || touchedBases.includes('home')
        : touchedBases.includes(baseKey)
      return isTaggedOut ? 'out' : baseKey
    }
    if (baseKey === 'first') {
      if (outIdSet.has('first')) return 'out'
      return firstAdvances ? 'second' : 'first'
    }
    if (baseKey === 'second') {
      if (outIdSet.has('second')) return 'out'
      return secondAdvances ? 'third' : 'second'
    }
    if (baseKey === 'third') {
      if (outIdSet.has('third')) return 'out'
      if (result === 'GO' || result === 'FC' || result === 'DP') {
        return thirdAdvances ? 'home' : 'third'
      }
      return forcedAtStart[baseKey] ? getNextBase(baseKey) : baseKey
    }
    if (isGrounderChoice || result === 'DP') {
      return baseKey
    }
    if (result === 'GO') {
      return forcedAtStart[baseKey] ? getNextBase(baseKey) : baseKey
    }
    return baseKey
  }

  push('first', first, 'first', defaultRunnerDestination('first'))
  push('second', second, 'second', defaultRunnerDestination('second'))
  push('third', third, 'third', defaultRunnerDestination('third'))

  return {
    result,
    assignments,
    outResolution: true,
    originalResult: result,
  }
}

// ─── Merged build-the-play / runner-placement plan ────────────────────────────
// The runner placement panel shows one row per active runner (+ the batter),
// with a current `position` ('first'|'second'|'third'|'home'|'out') defaulted
// from the same prediction logic as before (computePendingState /
// computePendingOutState) and then optionally overridden by manual picks.
export const BASE_STEP_ORDER = ['first', 'second', 'third', 'home']

// A runner can't be nudged back past where they actually started this play —
// for the batter that floor is first base (their best-case outcome), for a
// runner already on base it's the base they started the play on.
export function runnerFloorBase(id, origin) {
  return id === 'batter' ? 'first' : origin
}

export function stepBaseValue(position, direction, floor) {
  const idx = BASE_STEP_ORDER.indexOf(position)
  if (idx === -1) return position
  const floorIdx = BASE_STEP_ORDER.indexOf(floor)
  const rawNext = direction === 'advance' ? idx + 1 : idx - 1
  const clampedIdx = Math.max(floorIdx, Math.min(BASE_STEP_ORDER.length - 1, rawNext))
  return BASE_STEP_ORDER[clampedIdx]
}

// Same chain as computePendingOutState's forcedAtStart, plus the batter (who
// is always "forced" to run to first) — used so moving one forced runner to a
// new destination carries the rest of an intact force chain along with it.
export function computeForcedChainIds(runners = {}) {
  return getForcedRunnerIds(runners)
}

// Where a runner should land if they're pulled out of the "out" column but
// were never manually placed there (i.e. computePendingOutState auto-detected
// the out) — the base they'd have reached had that play not gotten them.
export function computeFallbackSafePosition(id, origin, runnersAtStart) {
  if (id === 'batter') return 'first'
  const forcedIds = new Set(computeForcedChainIds(runnersAtStart))
  return forcedIds.has(id) ? getNextBase(origin) : origin
}

export function isHomeRunResult(result) {
  return result === 'HR' || result === 'IPHR'
}

export function computeBaselineRunnerAssignments(inPlayState, runners, batterRunner) {
  if (!inPlayState || isHomeRunResult(inPlayState.result)) return null
  const fielderChain = inPlayState.fielderChain || []
  const primaryPosition = inPlayState.isBuddyJump
    ? (fielderChain[1] || fielderChain[0] || null)
    : (fielderChain[0] || null)
  if (inPlayState.resultType === 'hit' && NEEDS_RESOLUTION.has(inPlayState.result)) {
    return computePendingState(inPlayState.result, runners, batterRunner)
  }
  if (inPlayState.resultType === 'error') {
    return computePendingState('ROE', runners, batterRunner)
  }
  if (IN_PLAY_OUT_OPTIONS.includes(inPlayState.result)) {
    return computePendingOutState(inPlayState.result, runners, batterRunner, { primaryPosition, fielderChain })
  }
  return null
}

export function buildRunnerEntriesFromAssignments(pending, runnersAtStart) {
  if (!pending?.assignments) return []
  return pending.assignments.map((assignment) => ({
    id: assignment.id,
    runner: assignment.runner,
    origin: assignment.origin,
    position: assignment.destination,
    outSource: assignment.destination === 'out' ? 'auto' : null,
    preOutPosition: null,
    manual: false,
    fallbackSafePosition: computeFallbackSafePosition(assignment.id, assignment.origin, runnersAtStart),
  }))
}

const STORED_RUNNER_DESTINATIONS = new Set(['first', 'second', 'third', 'home', 'out'])

// Plate appearances persist the resolved runner map as JSON so editor choices
// survive reloads and later PAs can replay the exact base state. Keep parsing
// tolerant of JSON strings for older imports and of a legacy `position` key.
export function normalizeStoredRunnerAssignments(value) {
  let rows = value
  if (typeof rows === 'string') {
    try { rows = JSON.parse(rows) } catch { return null }
  }
  if (!Array.isArray(rows)) return null
  const normalized = []
  for (const row of rows) {
    const destination = row?.destination ?? row?.position
    if (!row?.id || !row?.runner || !STORED_RUNNER_DESTINATIONS.has(destination)) return null
    normalized.push({
      id: String(row.id),
      runner: row.runner,
      origin: row.origin ?? null,
      destination,
      isBatter: Boolean(row.isBatter ?? row.is_batter ?? row.id === 'batter'),
      ...(['first', 'second', 'third', 'home'].includes(row.attemptedBase) ? { attemptedBase: row.attemptedBase } : {}),
    })
  }
  return normalized
}

export function serializeRunnerEntries(entries) {
  if (!Array.isArray(entries)) return null
  return entries.map((entry) => ({
    id: entry.id,
    runner: entry.runner,
    origin: entry.origin ?? null,
    destination: entry.position,
    isBatter: entry.id === 'batter',
    ...(entry.position === 'out' && ['first', 'second', 'third', 'home'].includes(entry.preOutPosition)
      ? { attemptedBase: entry.preOutPosition } : {}),
  }))
}

export function resolveScoringRunners(scoredRunnerIds, assignments = [], runnersBefore = {}, batter = null) {
  const assignmentsById = new Map(assignments.map((assignment) => [String(assignment.id), assignment]))
  return (scoredRunnerIds || []).map((runnerId) => (
    assignmentsById.get(String(runnerId))?.runner
    ?? (runnerId === 'batter' ? batter : runnersBefore?.[runnerId])
  )).filter(Boolean)
}

export function hydrateRunnerEntries(defaultEntries, storedAssignments) {
  const stored = normalizeStoredRunnerAssignments(storedAssignments)
  if (!stored) return defaultEntries
  const byId = new Map(stored.map((assignment) => [assignment.id, assignment]))
  return defaultEntries.map((entry) => {
    const saved = byId.get(String(entry.id))
    const sameRunner = saved
      && String(saved.runner?.characterId ?? '') === String(entry.runner?.characterId ?? '')
      && String(saved.runner?.playerId ?? '') === String(entry.runner?.playerId ?? '')
    return sameRunner
      ? { ...entry, position: saved.destination, ...(saved.attemptedBase ? { preOutPosition: saved.attemptedBase } : {}), manual: true }
      : entry
  })
}

// Advancing/retreating a runner who'd otherwise land on a base another
// runner already occupies pushes that occupant one base the same direction
// too (recursively, in case that cascades into a third runner) — two runners
// can never end up sharing a base, matching how a force play actually works.
// Home plate is the one exception: runners stack there, so pushing stops.
export function applyManualRunnerStep(entries, id, direction) {
  const byId = Object.fromEntries(entries.map((entry) => [entry.id, entry]))
  const updates = {}
  const visiting = new Set()

  const push = (currentId) => {
    if (visiting.has(currentId)) return
    visiting.add(currentId)
    const entry = byId[currentId]
    if (!entry || entry.position === 'out') return
    const floor = runnerFloorBase(currentId, entry.origin)
    const fromPos = updates[currentId] ?? entry.position
    const nextPos = stepBaseValue(fromPos, direction, floor)
    updates[currentId] = nextPos
    if (nextPos === fromPos || nextPos === 'home') return
    const occupant = entries.find((other) => (
      other.id !== currentId && other.position !== 'out' && (updates[other.id] ?? other.position) === nextPos
    ))
    if (occupant) push(occupant.id)
  }

  push(id)

  return entries.map((entry) => (
    Object.prototype.hasOwnProperty.call(updates, entry.id)
      ? { ...entry, position: updates[entry.id], manual: true }
      : entry
  ))
}

export function applyManualRunnerOut(entries, id) {
  return entries.map((entry) => (
    entry.id === id
      ? { ...entry, preOutPosition: entry.position, position: 'out', outSource: 'manual', manual: true }
      : entry
  ))
}

export function applyManualRunnerReenter(entries, id) {
  return entries.map((entry) => {
    if (entry.id !== id) return entry
    const target = entry.outSource === 'manual'
      ? (entry.preOutPosition || runnerFloorBase(entry.id, entry.origin))
      : (entry.fallbackSafePosition || runnerFloorBase(entry.id, entry.origin))
    return { ...entry, position: target, outSource: null, preOutPosition: null, manual: true }
  })
}

export function applyManualRunnerDestination(entries, id, destination) {
  if (destination === 'out') return applyManualRunnerOut(entries, id)

  const targetIndex = BASE_STEP_ORDER.indexOf(destination)
  if (targetIndex === -1) return entries

  let nextEntries = entries
  const findEntry = () => nextEntries.find((entry) => entry.id === id)

  if (findEntry()?.position === 'out') {
    nextEntries = applyManualRunnerReenter(nextEntries, id)
  }

  let currentEntry = findEntry()
  if (!currentEntry) return nextEntries

  let currentIndex = BASE_STEP_ORDER.indexOf(currentEntry.position)
  if (currentIndex === -1 || currentIndex === targetIndex) return nextEntries

  const direction = targetIndex > currentIndex ? 'advance' : 'retreat'
  let safety = BASE_STEP_ORDER.length + 1

  while (currentEntry.position !== destination && safety > 0) {
    nextEntries = applyManualRunnerStep(nextEntries, id, direction)
    currentEntry = findEntry()
    if (!currentEntry) break
    const nextIndex = BASE_STEP_ORDER.indexOf(currentEntry.position)
    if (nextIndex === currentIndex) break
    currentIndex = nextIndex
    safety -= 1
  }

  return nextEntries
}

export function derivePendingResult(pending) {
  if (!pending?.outResolution) return pending?.result
  const outCount = getOutAssignments(pending).length
  const batterOut = pending.assignments.some((assignment) => assignment.isBatter && assignment.destination === 'out')
  const batterSafe = pending.assignments.some((assignment) => assignment.isBatter && assignment.destination !== 'out')

  if (outCount >= 3) return 'TP'
  if (outCount >= 2) return 'DP'
  if (pending.originalResult === 'SF') return 'SF'
  if (pending.originalResult === 'SH') return 'SH'
  // Batter reached safely on a batted-ball out-resolution play — a fielder's choice,
  // whether or not the defense's attempt to retire someone else actually succeeded
  // (e.g. a bunt fielded and thrown home that doesn't get the lead runner in time
  // still isn't a sacrifice — the defense had the batter beaten at first and chose
  // not to take it, which is FC by rule regardless of the throw's outcome).
  if (batterSafe) return 'FC'
  if (pending.originalResult === 'FO' || pending.originalResult === 'LO') return pending.originalResult
  if (batterOut) return 'GO'
  return pending.originalResult || pending.result
}

export function computeImmediateNextRunners(result, runners, batter) {
  const { first, second, third } = runners
  switch (result) {
    case 'HR':
    case 'IPHR':
    case 'TP':
      return { first: null, second: null, third: null }
    case 'SF':  return { first, second, third: null }
    case 'SH':  return { first: null, second: first, third: second }
    case 'FC':  return { first: batter, second, third }   // lead runner (first) out
    case 'DP':  return { first: null, second, third }     // runner on first out, batter out
    default:    return { first, second, third }           // K, GO, FO, LO — runners hold
  }
}

export function getRunsScoredOnPa(pa) {
  const isHomer = pa?.result === 'HR' || pa?.result === 'IPHR'
  return Number(pa?.rbi || 0) + (pa?.run_scored && !isHomer ? 1 : 0)
}

export function requiresInPlayFielderChain(result) {
  return result !== 'HR'
}
