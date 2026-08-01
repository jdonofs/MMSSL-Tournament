const RESULT_OUTS = new Set(['K', 'GO', 'FO', 'LO', 'SF', 'SH'])

function buildRunner(playerId, characterId) {
  return playerId == null || characterId == null ? null : { playerId, characterId }
}

function occupiedFlags(bases) {
  return {
    runner_on_first_before: Boolean(bases.first),
    runner_on_second_before: Boolean(bases.second),
    runner_on_third_before: Boolean(bases.third),
  }
}

function countHomeDestinations(destinations, participants) {
  return ['first', 'second', 'third', 'batter'].reduce(
    (total, slot) => (participants[slot] && destinations[slot] === 'home' ? total + 1 : total),
    0,
  )
}

function countOutDestinations(destinations, participants) {
  return ['first', 'second', 'third', 'batter'].reduce(
    (total, slot) => (participants[slot] && destinations[slot] === 'out' ? total + 1 : total),
    0,
  )
}

function defaultDestinationsForResult(result, bases) {
  const destinations = {
    batter: null,
    first: bases.first ? 'first' : null,
    second: bases.second ? 'second' : null,
    third: bases.third ? 'third' : null,
  }

  switch (result) {
    case '1B':
      destinations.batter = 'first'
      if (bases.first) destinations.first = 'second'
      if (bases.second) destinations.second = 'third'
      if (bases.third) destinations.third = 'home'
      break
    case '2B':
      destinations.batter = 'second'
      if (bases.first) destinations.first = 'third'
      if (bases.second) destinations.second = 'home'
      if (bases.third) destinations.third = 'home'
      break
    case '3B':
      destinations.batter = 'third'
      if (bases.first) destinations.first = 'home'
      if (bases.second) destinations.second = 'home'
      if (bases.third) destinations.third = 'home'
      break
    case 'HR':
    case 'IPHR':
      destinations.batter = 'home'
      if (bases.first) destinations.first = 'home'
      if (bases.second) destinations.second = 'home'
      if (bases.third) destinations.third = 'home'
      break
    case 'BB':
    case 'HBP':
      destinations.batter = 'first'
      if (bases.first && bases.second && bases.third) {
        destinations.first = 'second'
        destinations.second = 'third'
        destinations.third = 'home'
      } else if (bases.first && bases.second) {
        destinations.first = 'second'
        destinations.second = 'third'
      } else if (bases.first) {
        destinations.first = 'second'
      }
      break
    case 'ROE':
      destinations.batter = 'first'
      if (bases.first) destinations.first = 'second'
      if (bases.second) destinations.second = 'third'
      if (bases.third) destinations.third = 'home'
      break
    case 'SF':
      destinations.batter = 'out'
      if (bases.third) destinations.third = 'home'
      break
    case 'SH':
      destinations.batter = 'out'
      if (bases.first) destinations.first = 'second'
      if (bases.second) destinations.second = 'third'
      if (bases.third) destinations.third = 'home'
      break
    case 'FC':
      destinations.batter = 'first'
      if (bases.first) destinations.first = 'out'
      break
    case 'DP':
      destinations.batter = 'out'
      if (bases.first) destinations.first = 'out'
      break
    case 'TP':
      destinations.batter = 'out'
      if (bases.first) destinations.first = 'out'
      if (bases.second) destinations.second = 'out'
      if (bases.third) destinations.third = 'out'
      break
    case 'K':
    case 'GO':
    case 'FO':
    case 'LO':
    default:
      destinations.batter = 'out'
      break
  }

  return destinations
}

function scorePromotionOrder(result) {
  switch (result) {
    case '1B':
    case 'ROE':
      return ['second', 'first']
    case '2B':
      return ['first']
    case 'SH':
      return ['second', 'first']
    case 'GO':
    case 'FO':
    case 'LO':
    case 'FC':
    case 'SF':
    case 'K':
      return ['third', 'second', 'first']
    default:
      return []
  }
}

function scoreDemotionOrder(result) {
  switch (result) {
    case '2B':
      return ['second', 'first', 'third', 'batter']
    case '3B':
      return ['first', 'second', 'third', 'batter']
    case '1B':
    case 'ROE':
      return ['second', 'first', 'third', 'batter']
    default:
      return ['third', 'second', 'first', 'batter']
  }
}

function forcedLeadOrder(bases) {
  const order = []
  if (bases.first && bases.second && bases.third) order.push('third')
  if (bases.first && bases.second) order.push('second')
  if (bases.first) order.push('first')
  return order
}

function extraOutCandidateOrder(result, bases) {
  if (['GO', 'FC', 'DP', 'TP'].includes(result)) {
    return [...forcedLeadOrder(bases), 'third', 'second', 'first', 'batter']
  }
  return ['third', 'second', 'first', 'batter']
}

function maybeCascadeOneBaseAdvance(destinations, slot) {
  if (slot === 'second' && destinations.first === 'second') {
    destinations.first = 'third'
  }
}

function applyRunAdjustments({ result, bases, batter, batterScored, destinations, totalRuns }) {
  const participants = { ...bases, batter }
  const explicitScorers = new Set()

  if (batterScored && batter) {
    destinations.batter = 'home'
    explicitScorers.add('batter')
  }

  if (
    batter
    && destinations.batter !== 'home'
    && destinations.batter !== 'out'
    && totalRuns > countHomeDestinations(destinations, participants)
    && result === 'IPHR'
  ) {
    destinations.batter = 'home'
  }

  let missingRuns = totalRuns - countHomeDestinations(destinations, participants)
  for (const slot of scorePromotionOrder(result)) {
    if (missingRuns <= 0) break
    if (!participants[slot] || destinations[slot] === 'home' || destinations[slot] === 'out') continue
    destinations[slot] = 'home'
    maybeCascadeOneBaseAdvance(destinations, slot)
    missingRuns -= 1
  }

  return explicitScorers
}

function applyRunDemotions({ result, bases, batter, destinations, totalRuns, outsTarget, explicitScorers }) {
  const participants = { ...bases, batter }
  let currentRuns = countHomeDestinations(destinations, participants)
  let outCapacity = Math.max(0, outsTarget - countOutDestinations(destinations, participants))

  for (const slot of scoreDemotionOrder(result)) {
    if (currentRuns <= totalRuns || outCapacity <= 0) break
    if (!participants[slot] || destinations[slot] !== 'home' || explicitScorers.has(slot)) continue
    destinations[slot] = 'out'
    currentRuns -= 1
    outCapacity -= 1
  }
}

function applyExtraOuts({ result, bases, batter, destinations, outsTarget }) {
  const participants = { ...bases, batter }
  let needed = outsTarget - countOutDestinations(destinations, participants)
  for (const slot of extraOutCandidateOrder(result, bases)) {
    if (needed <= 0) break
    if (!participants[slot] || destinations[slot] === 'out' || destinations[slot] === 'home') continue
    destinations[slot] = 'out'
    needed -= 1
  }
}

function materializeNextBases(destinations, bases, batter) {
  const participants = { ...bases, batter }
  const next = { first: null, second: null, third: null }

  ;['third', 'second', 'first', 'batter'].forEach((slot) => {
    const destination = destinations[slot]
    if (!participants[slot] || !['first', 'second', 'third'].includes(destination)) return
    if (!next[destination]) next[destination] = participants[slot]
  })

  return next
}

function countRemainingAppearances(teamState) {
  return teamState.lineup.reduce(
    (total, row) => total + Math.max(0, row.plate_appearances.length - teamState.nextIndexByOrder[row.batting_order]),
    0,
  )
}

export function calculateTournamentOneOutsForPa(result, outsOnPlay = null) {
  if (outsOnPlay != null) return Number(outsOnPlay)
  if (result === 'TP') return 3
  if (result === 'DP') return 2
  if (result === 'FC') return 1
  return RESULT_OUTS.has(result) ? 1 : 0
}

export function outsFromImportedInningsPitched(inningsPitched = 0) {
  const innings = Number(inningsPitched || 0)
  const whole = Math.trunc(innings)
  const fraction = Number((innings - whole).toFixed(3))

  if (Math.abs(fraction - 0.1) < 0.001) return whole * 3 + 1
  if (Math.abs(fraction - 0.2) < 0.001) return whole * 3 + 2

  return whole * 3 + Math.round(fraction * 3)
}

function sortPitchingStintsForAssignment(rows = []) {
  return [...rows].sort((a, b) => {
    const slotA = Number(a.slot)
    const slotB = Number(b.slot)
    const hasSlotA = Number.isFinite(slotA) && slotA > 0
    const hasSlotB = Number.isFinite(slotB) && slotB > 0
    if (hasSlotA && hasSlotB && slotA !== slotB) return slotA - slotB
    if (hasSlotA !== hasSlotB) return hasSlotA ? -1 : 1
    return Number(a.id || 0) - Number(b.id || 0)
  })
}

export function isTournamentOfficialAtBatResult(result) {
  return !['BB', 'HBP', 'SF', 'SH'].includes(String(result || ''))
}

export function buildTournamentOneChronologicalPas({
  workbookGame,
  dbGame,
  playerByName,
  characterByName,
}) {
  const buildTeamState = (owner) => ({
    lineup: workbookGame.battingRows
      .filter((row) => row.player_name === owner)
      .sort((a, b) => a.batting_order - b.batting_order),
    nextIndexByOrder: Object.fromEntries(
      workbookGame.battingRows
        .filter((row) => row.player_name === owner)
        .map((row) => [row.batting_order, 0]),
    ),
    cursor: 0,
  })

  const topState = buildTeamState(workbookGame.team_a_owner)
  const bottomState = buildTeamState(workbookGame.team_b_owner)
  const totalExpectedPas = [...topState.lineup, ...bottomState.lineup]
    .reduce((total, row) => total + row.plate_appearances.length, 0)

  const entries = []
  let isTop = true
  let inning = 1
  let outsInHalf = 0
  let bases = { first: null, second: null, third: null }

  while (entries.length < totalExpectedPas) {
    const activeState = isTop ? topState : bottomState
    const batterRow = activeState.lineup[activeState.cursor]
    if (!batterRow) break

    const appearanceIndex = activeState.nextIndexByOrder[batterRow.batting_order]
    const appearance = batterRow.plate_appearances[appearanceIndex]
    if (!appearance) {
      const remainingActive = countRemainingAppearances(activeState)
      const remainingOther = countRemainingAppearances(isTop ? bottomState : topState)
      if (remainingActive === 0 && remainingOther === 0) break
      if (remainingActive === 0 && remainingOther > 0) {
        bases = { first: null, second: null, third: null }
        outsInHalf = 0
        if (isTop) isTop = false
        else {
          isTop = true
          inning += 1
        }
        continue
      }
      throw new Error(`Tournament 1 chronology replay stalled at ${workbookGame.game_code}`)
    }

    const playerId = playerByName[batterRow.player_name]?.id || null
    const characterId = characterByName[batterRow.character_name]?.id || null
    const battingTeamId = isTop ? dbGame.team_a_player_id : dbGame.team_b_player_id
    const defensiveTeamId = isTop ? dbGame.team_b_player_id : dbGame.team_a_player_id
    const runScored = Boolean(appearance.run_scored) || appearance.result === 'HR' || appearance.result === 'IPHR'
    const batter = buildRunner(playerId, characterId)
    const totalRuns = Number(appearance.rbi || 0) + (runScored && appearance.result !== 'HR' && appearance.result !== 'IPHR' ? 1 : 0)
    const outsTarget = calculateTournamentOneOutsForPa(appearance.result)
    const destinations = defaultDestinationsForResult(appearance.result, bases)
    const explicitScorers = applyRunAdjustments({
      result: appearance.result,
      bases,
      batter,
      batterScored: runScored,
      destinations,
      totalRuns,
    })
    applyRunDemotions({
      result: appearance.result,
      bases,
      batter,
      destinations,
      totalRuns,
      outsTarget,
      explicitScorers,
    })
    applyExtraOuts({
      result: appearance.result,
      bases,
      batter,
      destinations,
      outsTarget,
    })

    entries.push({
      game_id: dbGame.id,
      player_id: playerId,
      character_id: characterId,
      batting_team_id: battingTeamId,
      defensive_team_id: defensiveTeamId,
      inning,
      pa_number: entries.length + 1,
      result: appearance.result,
      rbi: Number(appearance.rbi || 0),
      run_scored: runScored,
      is_official_ab: isTournamentOfficialAtBatResult(appearance.result),
      ...occupiedFlags(bases),
    })

    bases = materializeNextBases(destinations, bases, batter)
    activeState.nextIndexByOrder[batterRow.batting_order] = appearanceIndex + 1
    activeState.cursor = (activeState.cursor + 1) % activeState.lineup.length

    outsInHalf += outsTarget
    if (outsInHalf >= 3) {
      bases = { first: null, second: null, third: null }
      outsInHalf = 0
      if (isTop) isTop = false
      else {
        isTop = true
        inning += 1
      }
    }
  }

  if (entries.length !== totalExpectedPas) {
    throw new Error(`Tournament 1 chronology produced ${entries.length} entries, expected ${totalExpectedPas} for ${workbookGame.game_code}`)
  }

  return entries
}

export function assignTournamentPitchersToPas(plateAppearances = [], pitchingStints = []) {
  const stintsByTeam = pitchingStints.reduce((acc, stint) => {
    const key = String(stint.player_id)
    if (!acc[key]) acc[key] = []
    acc[key].push({
      ...stint,
      remainingOuts: outsFromImportedInningsPitched(stint.innings_pitched),
    })
    return acc
  }, {})

  const stateByTeam = Object.fromEntries(
    Object.entries(stintsByTeam).map(([teamId, stints]) => [
      teamId,
      { index: 0, stints: sortPitchingStintsForAssignment(stints) },
    ]),
  )

  return plateAppearances.map((pa) => {
    const state = stateByTeam[String(pa.defensive_team_id)] || { index: 0, stints: [] }

    while (state.index < state.stints.length && state.stints[state.index].remainingOuts <= 0) {
      state.index += 1
    }

    const activeStint = state.stints[state.index] || state.stints[state.stints.length - 1] || null
    if (activeStint) {
      activeStint.remainingOuts -= calculateTournamentOneOutsForPa(pa.result, pa.outs_on_play)
    }

    return {
      ...pa,
      pitcher_id: activeStint?.character_id ?? null,
      pitcher_player_id: activeStint?.player_id ?? pa.defensive_team_id ?? null,
    }
  })
}
