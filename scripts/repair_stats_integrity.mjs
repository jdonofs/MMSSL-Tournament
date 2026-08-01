import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')
const applyUpdates = process.argv.includes('--apply')
const sqlFileFlagIndex = process.argv.indexOf('--sql-file')
const sqlFilePath = sqlFileFlagIndex >= 0 && process.argv[sqlFileFlagIndex + 1]
  ? path.resolve(repoRoot, process.argv[sqlFileFlagIndex + 1])
  : null

function loadEnvFile(filePath) {
  const env = {}
  const content = fs.readFileSync(filePath, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) continue
    env[trimmed.slice(0, eqIndex)] = trimmed.slice(eqIndex + 1)
  }
  return env
}

const env = loadEnvFile(path.join(repoRoot, '.env'))
const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)
const tournament1Workbook = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'src', 'data', 'tournament1Workbook.json'), 'utf8'),
)

const RESULT_OUTS = new Set(['K', 'GO', 'FO', 'LO', 'SF', 'SH'])
const HIT_RESULTS = new Set(['1B', '2B', '3B', 'HR', 'IPHR'])
const OFFICIAL_AB_EXCLUSIONS = new Set(['BB', 'HBP', 'SF', 'SH'])
const generatedSqlStatements = []

function toNumber(value, fallback = 0) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function gameSortKey(code) {
  return Number(String(code || '').replace(/\D/g, '')) || 0
}

function isHomeRunResult(result) {
  return result === 'HR' || result === 'IPHR'
}

function isOfficialAtBatResult(result) {
  return !OFFICIAL_AB_EXCLUSIONS.has(String(result || ''))
}

function calculateOutsForPa(result, outsOnPlay = null) {
  if (outsOnPlay != null) return Number(outsOnPlay)
  if (result === 'TP') return 3
  if (result === 'DP') return 2
  if (result === 'FC') return 1
  return RESULT_OUTS.has(result) ? 1 : 0
}

function outsFromInningsPitched(inningsPitched = 0) {
  const innings = Number(inningsPitched || 0)
  const whole = Math.trunc(innings)
  const fraction = Number((innings - whole).toFixed(3))

  if (Math.abs(fraction - 0.1) < 0.001) return whole * 3 + 1
  if (Math.abs(fraction - 0.2) < 0.001) return whole * 3 + 2

  return whole * 3 + Math.round(fraction * 3)
}

function inningsPitchedFromOuts(outs = 0) {
  const safeOuts = Math.max(0, Number(outs || 0))
  const wholeInnings = Math.floor(safeOuts / 3)
  const remainingOuts = safeOuts % 3
  return Number(`${wholeInnings}.${remainingOuts}`)
}

function parsePlateAppearanceSummary(summary = '') {
  const text = String(summary || '')
  const rbiMatch = text.match(/(\d+)\s*RBI/i)
  const runMatch = text.match(/(\d+)\s*R\b/i)
  return {
    rbi: rbiMatch ? toNumber(rbiMatch[1]) : 0,
    run_scored: runMatch ? toNumber(runMatch[1]) > 0 : false,
  }
}

function groupBy(rows = [], keyFn) {
  return rows.reduce((acc, row) => {
    const key = keyFn(row)
    if (!acc[key]) acc[key] = []
    acc[key].push(row)
    return acc
  }, {})
}

function getPaScoringRuns(pa = {}) {
  return Number(pa.rbi || 0) + (pa.run_scored && !isHomeRunResult(pa.result) ? 1 : 0)
}

function normalizeSeasonGames(seasonGames = [], seasonTeams = []) {
  const playerIdByTeamId = Object.fromEntries(seasonTeams.map((team) => [String(team.id), team.player_id]))
  return seasonGames.map((game) => ({
    ...game,
    team_a_player_id: playerIdByTeamId[String(game.away_team_id)] ?? null,
    team_b_player_id: playerIdByTeamId[String(game.home_team_id)] ?? null,
  }))
}

function deriveOffense(game, outsRecorded) {
  const halfInning = Math.floor(outsRecorded / 3)
  const isTop = halfInning % 2 === 0
  const awayPlayerId = game.home_away_swapped ? game.team_b_player_id : game.team_a_player_id
  const homePlayerId = game.home_away_swapped ? game.team_a_player_id : game.team_b_player_id
  return {
    pitchingPlayerId: isTop ? homePlayerId : awayPlayerId,
  }
}

function toSqlLiteral(value) {
  if (value == null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  return `'${String(value).replace(/'/g, "''")}'`
}

function buildUpdateSql(table, row) {
  const { id, needsUpdate, ...payload } = row
  const assignments = Object.entries(payload).map(([key, value]) => `${key} = ${toSqlLiteral(value)}`)
  return `update public.${table} set ${assignments.join(', ')} where id = ${toSqlLiteral(id)};`
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

function sortByPaNumber(rows = []) {
  return [...rows].sort((a, b) => {
    const paA = Number(a.pa_number || 0)
    const paB = Number(b.pa_number || 0)
    if (paA !== paB) return paA - paB
    return Number(a.id || 0) - Number(b.id || 0)
  })
}

function sortByPaChronology(rows = []) {
  return [...rows].sort((a, b) => {
    const paA = Number(a.pa_number)
    const paB = Number(b.pa_number)
    const hasPaA = Number.isFinite(paA) && paA > 0
    const hasPaB = Number.isFinite(paB) && paB > 0
    if (hasPaA && hasPaB && paA !== paB) return paA - paB
    if (hasPaA !== hasPaB) return hasPaA ? -1 : 1

    const createdA = a.created_at ? new Date(a.created_at).getTime() : 0
    const createdB = b.created_at ? new Date(b.created_at).getTime() : 0
    if (createdA !== createdB) return createdA - createdB

    return Number(a.id || 0) - Number(b.id || 0)
  })
}

function buildRunner(playerId, characterId) {
  return playerId == null || characterId == null ? null : { playerId, characterId }
}

function runnerMatchesEvent(runner, run = {}) {
  return runner
    && String(run.scoring_player_id) === String(runner.playerId)
    && String(run.scoring_character_id) === String(runner.characterId)
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

function extractTournamentOneWorkbookGames() {
  const rows = tournament1Workbook.Scorebook || []
  const games = []

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] || []
    if (!String(row[0] || '').startsWith('Game ')) continue

    const meta = rows[index + 1] || []
    const gameCode = meta[5]
    if (!gameCode || gameSortKey(gameCode) > 10) continue

    const teamAOwner = meta[13] || null
    const teamBOwner = meta[17] || null
    const battingRows = []
    const pitchingRows = []

    const findSectionIndex = (label, startIndex) => {
      for (let cursor = startIndex; cursor < rows.length; cursor += 1) {
        if ((rows[cursor] || [])[0] === label) return cursor
        if (cursor > index + 1 && String((rows[cursor] || [])[0] || '').startsWith('Game ')) break
      }
      return -1
    }

    const parseBattingSection = (teamOwner, startIndex) => {
      const sectionIndex = teamOwner ? findSectionIndex(`${teamOwner} Batting`, startIndex) : -1
      if (sectionIndex === -1) return startIndex

      let cursor = sectionIndex + 2
      while (cursor < rows.length) {
        const battingRow = rows[cursor] || []
        const battingOrder = toNumber(battingRow[0])
        const characterName = battingRow[1]
        if (!battingOrder || !characterName) break

        const plateAppearances = []
        for (let paIndex = 0; paIndex < 5; paIndex += 1) {
          const result = battingRow[2 + paIndex * 2]
          const summary = battingRow[3 + paIndex * 2]
          if (!result) continue
          plateAppearances.push({
            result,
            ...parsePlateAppearanceSummary(summary),
          })
        }

        battingRows.push({
          player_name: teamOwner,
          character_name: characterName,
          batting_order: battingOrder,
          plate_appearances: plateAppearances,
        })
        cursor += 1
      }

      return cursor
    }

    const parsePitchingSection = (teamOwner, startIndex) => {
      const sectionIndex = teamOwner ? findSectionIndex(`${teamOwner} Pitching`, startIndex) : -1
      if (sectionIndex === -1) return startIndex

      let cursor = sectionIndex + 2
      while (cursor < rows.length) {
        const pitchRow = rows[cursor] || []
        const slot = toNumber(pitchRow[0])
        const characterName = pitchRow[1]
        if (!slot || !characterName) break

        pitchingRows.push({
          player_name: teamOwner,
          character_name: characterName,
          slot,
          innings_pitched: Number(pitchRow[2] || 0),
        })
        cursor += 1
      }

      return cursor
    }

    let searchIndex = index + 2
    searchIndex = parseBattingSection(teamAOwner, searchIndex)
    searchIndex = parsePitchingSection(teamAOwner, searchIndex)
    searchIndex = parseBattingSection(teamBOwner, searchIndex)
    parsePitchingSection(teamBOwner, searchIndex)

    games.push({
      game_code: gameCode,
      team_a_owner: teamAOwner,
      team_b_owner: teamBOwner,
      battingRows,
      pitchingRows,
    })
  }

  return games.sort((a, b) => gameSortKey(a.game_code) - gameSortKey(b.game_code))
}

function countRemainingAppearances(teamState) {
  return teamState.lineup.reduce(
    (total, row) => total + Math.max(0, row.plate_appearances.length - teamState.nextIndexByOrder[row.batting_order]),
    0,
  )
}

function buildTournamentOneChronologicalPas({
  workbookGame,
  dbGame,
  playerByName,
  characterByName,
  dbRowsByBatterKey = null,
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
        if (isTop) {
          isTop = false
        } else {
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
    const normalizedRunScored = Boolean(appearance.run_scored) || isHomeRunResult(appearance.result)
    const batter = buildRunner(playerId, characterId)
    const totalRuns = Number(appearance.rbi || 0) + (normalizedRunScored && !isHomeRunResult(appearance.result) ? 1 : 0)
    const outsTarget = calculateOutsForPa(appearance.result, null)
    const destinations = defaultDestinationsForResult(appearance.result, bases)
    const explicitScorers = applyRunAdjustments({
      result: appearance.result,
      bases,
      batter,
      batterScored: normalizedRunScored,
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

    const entry = {
      game_id: dbGame.id,
      player_id: playerId,
      character_id: characterId,
      batting_team_id: battingTeamId,
      defensive_team_id: defensiveTeamId,
      inning,
      pa_number: entries.length + 1,
      result: appearance.result,
      rbi: Number(appearance.rbi || 0),
      run_scored: normalizedRunScored,
      is_official_ab: isOfficialAtBatResult(appearance.result),
      ...occupiedFlags(bases),
      workbook_player_name: batterRow.player_name,
      workbook_character_name: batterRow.character_name,
      batting_order: batterRow.batting_order,
      appearance_index: appearanceIndex,
    }

    if (dbRowsByBatterKey) {
      const key = `${dbGame.id}:${playerId}:${characterId}`
      const dbRows = dbRowsByBatterKey[key] || []
      const dbRow = dbRows[appearanceIndex]
      if (!dbRow) {
        throw new Error(`No DB PA row matched ${workbookGame.game_code} ${batterRow.player_name}/${batterRow.character_name} PA ${appearanceIndex + 1}`)
      }
      if (String(dbRow.result || '') !== String(appearance.result || '') || Number(dbRow.rbi || 0) !== Number(appearance.rbi || 0)) {
        throw new Error(`DB/workbook mismatch for ${workbookGame.game_code} ${batterRow.player_name}/${batterRow.character_name} PA ${appearanceIndex + 1}`)
      }
      entry.id = dbRow.id
      entry.current = dbRow
    }

    entries.push(entry)
    bases = materializeNextBases(destinations, bases, batter)

    activeState.nextIndexByOrder[batterRow.batting_order] = appearanceIndex + 1
    activeState.cursor = (activeState.cursor + 1) % activeState.lineup.length

    outsInHalf += outsTarget
    if (outsInHalf >= 3) {
      bases = { first: null, second: null, third: null }
      outsInHalf = 0
      if (isTop) {
        isTop = false
      } else {
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

function buildWorkbookPitchingAssignments(workbookGame, playerByName, characterByName) {
  return sortPitchingStintsForAssignment(
    (workbookGame?.pitchingRows || [])
      .map((row) => ({
        slot: row.slot,
        player_id: playerByName[row.player_name]?.id || null,
        character_id: characterByName[row.character_name]?.id || null,
        innings_pitched: Number(row.innings_pitched || 0),
      }))
      .filter((row) => row.player_id && row.character_id),
  )
}

function assignPitchersToPas(plateAppearances = [], pitchingStints = []) {
  const teamStates = Object.fromEntries(
    Object.entries(groupBy(sortPitchingStintsForAssignment(pitchingStints), (stint) => String(stint.player_id)))
      .map(([playerId, stints]) => [
        playerId,
        {
          index: 0,
          stints: stints.map((stint) => ({
            ...stint,
            remainingOuts: outsFromInningsPitched(stint.innings_pitched),
          })),
        },
      ]),
  )

  return plateAppearances.map((pa) => {
    const state = teamStates[String(pa.defensive_team_id)] || { index: 0, stints: [] }

    while (state.index < state.stints.length && state.stints[state.index].remainingOuts <= 0) {
      state.index += 1
    }

    const activeStint = state.stints[state.index] || state.stints[state.stints.length - 1] || null
    const outsOnPlay = calculateOutsForPa(pa.result, pa.outs_on_play)
    if (activeStint) {
      activeStint.remainingOuts -= outsOnPlay
    }

    return {
      ...pa,
      pitcher_id: activeStint?.character_id ?? null,
      pitcher_player_id: activeStint?.player_id ?? pa.defensive_team_id ?? null,
    }
  })
}

async function applyRowUpdates(table, rows, label) {
  const changed = rows.filter((row) => row.needsUpdate)
  if (sqlFilePath) {
    generatedSqlStatements.push(...changed.map((row) => buildUpdateSql(table, row)))
  }
  if (!changed.length) {
    console.log(`${label}: 0 row(s) need updates`)
    return 0
  }

  console.log(`${label}: ${changed.length} row(s) ${applyUpdates ? 'updating' : 'would update'}`)
  if (!applyUpdates) return changed.length

  const batchSize = 20
  for (let index = 0; index < changed.length; index += batchSize) {
    const batch = changed.slice(index, index + batchSize)
    await Promise.all(batch.map(async (row) => {
      const { id, needsUpdate, ...payload } = row
      const { error } = await supabase.from(table).update(payload).eq('id', id)
      if (error) throw error
    }))
  }

  return changed.length
}

function recomputePitchingByGame({ games, pas, stints, runs, pitches }) {
  const pasByGameId = groupBy(pas, (row) => String(row.game_id))
  const stintsByGameId = groupBy(stints, (row) => String(row.game_id))
  const runsByGameId = groupBy(runs, (row) => String(row.game_id))
  const pitchesByPaId = groupBy(pitches, (row) => String(row.pa_id))
  const recomputedByStintId = {}

  for (const game of games) {
    const gameId = String(game.id)
    const gamePas = sortByPaChronology(pasByGameId[gameId] || [])
    const gameStints = [...(stintsByGameId[gameId] || [])].sort((a, b) => {
      const aTime = new Date(a.created_at || 0).getTime()
      const bTime = new Date(b.created_at || 0).getTime()
      return aTime - bTime || toNumber(a.id) - toNumber(b.id)
    })
    const gameRuns = runsByGameId[gameId] || []
    const nextStatsByStintId = Object.fromEntries(
      gameStints.map((stint) => [String(stint.id), {
        innings_pitched: 0,
        hits_allowed: 0,
        runs_allowed: 0,
        earned_runs: 0,
        walks: 0,
        strikeouts: 0,
        hr_allowed: 0,
        pitches_thrown: 0,
        strikes_thrown: 0,
        _outs: 0,
      }]),
    )

    let outsBeforePa = 0

    for (const pa of gamePas) {
      const defense = deriveOffense(game, outsBeforePa)
      const paTime = new Date(pa.created_at || 0).getTime()
      let activeStint = null

      if (pa.pitcher_id != null) {
        const candidateStints = gameStints.filter((stint) => (
          String(stint.character_id) === String(pa.pitcher_id)
          && String(stint.player_id) === String(defense.pitchingPlayerId)
        ))
        const eligibleCandidates = candidateStints.filter((stint) => (
          new Date(stint.created_at || 0).getTime() <= paTime
        ))
        activeStint = eligibleCandidates[eligibleCandidates.length - 1] || candidateStints[0] || null
      }

      if (!activeStint) {
        const eligibleStints = gameStints.filter((stint) => (
          String(stint.player_id) === String(defense.pitchingPlayerId)
          && new Date(stint.created_at || 0).getTime() <= paTime
        ))
        activeStint = eligibleStints[eligibleStints.length - 1] || null
      }

      if (activeStint) {
        const targetStats = nextStatsByStintId[String(activeStint.id)]
        const outs = calculateOutsForPa(pa.result, pa.outs_on_play)
        const paRuns = gameRuns.filter((run) => String(run.pa_id) === String(pa.id))
        const paPitches = pitchesByPaId[String(pa.id)] || []

        targetStats._outs += outs
        if (HIT_RESULTS.has(pa.result)) targetStats.hits_allowed += 1
        if (isHomeRunResult(pa.result)) targetStats.hr_allowed += 1
        if (pa.result === 'BB') targetStats.walks += 1
        if (pa.result === 'K') targetStats.strikeouts += 1
        targetStats.pitches_thrown += paPitches.length
        targetStats.strikes_thrown += paPitches.filter((pitch) => pitch.result !== 'ball' && pitch.result !== 'hbp').length

        if (paRuns.length > 0) {
          for (const run of paRuns) {
            let chargedTarget = targetStats
            if (Number(run.charged_to_pitcher_id) !== Number(activeStint.character_id)) {
              const chargedStints = gameStints.filter((stint) => (
                Number(stint.character_id) === Number(run.charged_to_pitcher_id)
                && new Date(stint.created_at || 0).getTime() <= paTime
              ))
              const chargedStint = chargedStints[chargedStints.length - 1]
              if (chargedStint) chargedTarget = nextStatsByStintId[String(chargedStint.id)]
            }
            chargedTarget.runs_allowed += 1
            if (run.is_earned_run !== false) chargedTarget.earned_runs += 1
          }
        } else {
          const fallbackRuns = getPaScoringRuns(pa)
          if (fallbackRuns > 0) {
            targetStats.runs_allowed += fallbackRuns
            if (pa.is_earned_run !== false) targetStats.earned_runs += fallbackRuns
          }
        }
      }

      outsBeforePa += calculateOutsForPa(pa.result, pa.outs_on_play)
    }

    for (const [stintId, stats] of Object.entries(nextStatsByStintId)) {
      stats.innings_pitched = inningsPitchedFromOuts(stats._outs)
      delete stats._outs
      recomputedByStintId[stintId] = stats
    }
  }

  return recomputedByStintId
}

async function repairSeasonPlateAppearances() {
  const [
    { data: seasonPas, error: pasError },
    { data: seasonRuns, error: runsError },
  ] = await Promise.all([
    supabase
      .from('season_plate_appearances')
      .select('id,game_id,season_id,player_id,character_id,result,run_scored,is_official_ab')
      .order('id'),
    supabase
      .from('season_runs_scored')
      .select('id,game_id,season_id,pa_id,scoring_player_id,scoring_character_id')
      .order('id'),
  ])
  if (pasError) throw pasError
  if (runsError) throw runsError

  const runsByPaId = groupBy(seasonRuns || [], (run) => String(run.pa_id))
  const gameIdsWithRunRows = new Set((seasonRuns || []).map((run) => String(run.game_id)))

  const updates = (seasonPas || []).map((pa) => {
    const next = { id: pa.id }
    let needsUpdate = false

    const expectedOfficialAb = isOfficialAtBatResult(pa.result)
    if (Boolean(pa.is_official_ab) !== expectedOfficialAb) {
      next.is_official_ab = expectedOfficialAb
      needsUpdate = true
    }

    let expectedRunScored = Boolean(pa.run_scored)
    if (gameIdsWithRunRows.has(String(pa.game_id))) {
      expectedRunScored = (runsByPaId[String(pa.id)] || []).some((run) => (
        String(run.scoring_player_id) === String(pa.player_id)
        && String(run.scoring_character_id) === String(pa.character_id)
      ))
    } else if (isHomeRunResult(pa.result)) {
      expectedRunScored = true
    }

    if (Boolean(pa.run_scored) !== expectedRunScored) {
      next.run_scored = expectedRunScored
      needsUpdate = true
    }

    return { ...next, needsUpdate }
  })

  return applyRowUpdates('season_plate_appearances', updates, 'Season plate appearances')
}

async function repairTournamentOnePlateAppearances() {
  const [
    { data: tournaments, error: tournamentsError },
    { data: players, error: playersError },
    { data: characters, error: charactersError },
  ] = await Promise.all([
    supabase.from('tournaments').select('id,tournament_number').eq('tournament_number', 1).limit(1),
    supabase.from('players').select('id,name'),
    supabase.from('characters').select('id,name'),
  ])
  if (tournamentsError) throw tournamentsError
  if (playersError) throw playersError
  if (charactersError) throw charactersError

  const tournament = (tournaments || [])[0]
  if (!tournament) {
    console.log('Tournament 1 plate appearances: tournament not found')
    return 0
  }

  const [
    { data: games, error: gamesError },
    { data: pas, error: pasError },
    { data: pitchingStints, error: pitchingError },
  ] = await Promise.all([
    supabase
      .from('games')
      .select('id,game_code,team_a_player_id,team_b_player_id')
      .eq('tournament_id', tournament.id)
      .order('id'),
    supabase
      .from('plate_appearances')
      .select('id,game_id,player_id,character_id,batting_team_id,defensive_team_id,pitcher_id,pitcher_player_id,inning,pa_number,result,rbi,run_scored,is_official_ab,runner_on_first_before,runner_on_second_before,runner_on_third_before')
      .in('game_id', [])
      .limit(0),
    supabase
      .from('pitching_stints')
      .select('id,game_id,player_id,character_id,innings_pitched')
      .in('game_id', [])
      .limit(0),
  ])
  if (gamesError) throw gamesError

  const gameIds = (games || []).map((game) => game.id)
  let livePas = []
  let livePitchingStints = []
  if (gameIds.length) {
    const [{ data, error }, { data: stintData, error: stintError }] = await Promise.all([
      supabase
        .from('plate_appearances')
        .select('id,game_id,player_id,character_id,batting_team_id,defensive_team_id,pitcher_id,pitcher_player_id,inning,pa_number,result,rbi,run_scored,is_official_ab,runner_on_first_before,runner_on_second_before,runner_on_third_before')
        .in('game_id', gameIds)
        .order('pa_number')
        .order('id'),
      supabase
        .from('pitching_stints')
        .select('id,game_id,player_id,character_id,innings_pitched')
        .in('game_id', gameIds)
        .order('id'),
    ])
    if (error) throw error
    if (stintError) throw stintError
    livePas = data || []
    livePitchingStints = stintData || []
  }
  if (pasError || pitchingError) {
    // Unused seed queries above are only there to keep Promise.all structure uniform when gameIds are empty.
  }

  const playerByName = Object.fromEntries((players || []).map((player) => [player.name, player]))
  const characterByName = Object.fromEntries((characters || []).map((character) => [character.name, character]))
  const dbGameByCode = Object.fromEntries((games || []).map((game) => [game.game_code, game]))
  const dbRowsByBatterKey = Object.fromEntries(
    Object.entries(groupBy(livePas, (pa) => `${pa.game_id}:${pa.player_id}:${pa.character_id}`))
      .map(([key, rows]) => [key, sortByPaNumber(rows)]),
  )
  const workbookGames = extractTournamentOneWorkbookGames()
  const updates = []

  for (const workbookGame of workbookGames) {
    const dbGame = dbGameByCode[workbookGame.game_code]
    if (!dbGame) continue

    const chronologicalPas = buildTournamentOneChronologicalPas({
      workbookGame,
      dbGame,
      playerByName,
      characterByName,
      dbRowsByBatterKey,
    })
    const workbookPitchingAssignments = buildWorkbookPitchingAssignments(
      workbookGame,
      playerByName,
      characterByName,
    )
    const attributedPas = assignPitchersToPas(
      chronologicalPas,
      workbookPitchingAssignments,
    )

    attributedPas.forEach((expected) => {
      const current = expected.current || {}
      const next = {
        id: expected.id,
        batting_team_id: expected.batting_team_id,
        defensive_team_id: expected.defensive_team_id,
        pitcher_id: expected.pitcher_id,
        pitcher_player_id: expected.pitcher_player_id,
        inning: expected.inning,
        pa_number: expected.pa_number,
        run_scored: expected.run_scored,
        is_official_ab: expected.is_official_ab,
        runner_on_first_before: expected.runner_on_first_before,
        runner_on_second_before: expected.runner_on_second_before,
        runner_on_third_before: expected.runner_on_third_before,
      }
      const needsUpdate =
        String(current.batting_team_id ?? '') !== String(next.batting_team_id ?? '')
        || String(current.defensive_team_id ?? '') !== String(next.defensive_team_id ?? '')
        || String(current.pitcher_id ?? '') !== String(next.pitcher_id ?? '')
        || String(current.pitcher_player_id ?? '') !== String(next.pitcher_player_id ?? '')
        || Number(current.inning || 0) !== Number(next.inning || 0)
        || Number(current.pa_number || 0) !== Number(next.pa_number || 0)
        || Boolean(current.run_scored) !== Boolean(next.run_scored)
        || Boolean(current.is_official_ab) !== Boolean(next.is_official_ab)
        || Boolean(current.runner_on_first_before) !== Boolean(next.runner_on_first_before)
        || Boolean(current.runner_on_second_before) !== Boolean(next.runner_on_second_before)
        || Boolean(current.runner_on_third_before) !== Boolean(next.runner_on_third_before)

      updates.push({ ...next, needsUpdate })
    })
  }

  const count = await applyRowUpdates('plate_appearances', updates, 'Tournament 1 plate appearances')
  return {
    count,
    updates,
  }
}

async function repairPitchingStints({ tournamentPaOverrides = [] } = {}) {
  const [
    { data: games, error: gamesError },
    { data: tournamentPas, error: tournamentPasError },
    { data: tournamentPitchingStints, error: tournamentPitchingError },
    { data: tournamentRuns, error: tournamentRunsError },
    { data: tournamentPitches, error: tournamentPitchesError },
    { data: seasonTeams, error: seasonTeamsError },
    { data: seasonGames, error: seasonGamesError },
    { data: seasonPas, error: seasonPasError },
    { data: seasonPitchingStints, error: seasonPitchingError },
    { data: seasonRuns, error: seasonRunsError },
    { data: seasonPitches, error: seasonPitchesError },
  ] = await Promise.all([
    supabase.from('games').select('id,team_a_player_id,team_b_player_id,home_away_swapped').order('created_at'),
    supabase.from('plate_appearances').select('id,game_id,pa_number,result,rbi,run_scored,is_earned_run,pitcher_id,created_at,outs_on_play').order('created_at'),
    supabase.from('pitching_stints').select('id,game_id,player_id,character_id,created_at,innings_pitched,hits_allowed,runs_allowed,earned_runs,walks,strikeouts,hr_allowed,pitches_thrown,strikes_thrown').order('created_at'),
    supabase.from('runs_scored').select('id,game_id,pa_id,charged_to_pitcher_id,is_earned_run').order('created_at'),
    supabase.from('pitches').select('id,pa_id,result').order('created_at'),
    supabase.from('season_teams').select('id,player_id').order('created_at'),
    supabase.from('season_schedule').select('id,away_team_id,home_team_id,home_away_swapped').order('created_at'),
    supabase.from('season_plate_appearances').select('id,game_id,pa_number,result,rbi,run_scored,is_earned_run,pitcher_id,created_at,outs_on_play').order('created_at'),
    supabase.from('season_pitching_stints').select('id,game_id,player_id,character_id,created_at,innings_pitched,hits_allowed,runs_allowed,earned_runs,walks,strikeouts,hr_allowed,pitches_thrown,strikes_thrown').order('created_at'),
    supabase.from('season_runs_scored').select('id,game_id,pa_id,charged_to_pitcher_id,is_earned_run').order('created_at'),
    supabase.from('season_pitches').select('id,pa_id,result').order('created_at'),
  ])

  if (gamesError) throw gamesError
  if (tournamentPasError) throw tournamentPasError
  if (tournamentPitchingError) throw tournamentPitchingError
  if (tournamentRunsError) throw tournamentRunsError
  if (tournamentPitchesError) throw tournamentPitchesError
  if (seasonTeamsError) throw seasonTeamsError
  if (seasonGamesError) throw seasonGamesError
  if (seasonPasError) throw seasonPasError
  if (seasonPitchingError) throw seasonPitchingError
  if (seasonRunsError) throw seasonRunsError
  if (seasonPitchesError) throw seasonPitchesError

  const normalizedSeasonGames = normalizeSeasonGames(seasonGames || [], seasonTeams || [])
  const tournamentPaOverrideById = Object.fromEntries(
    tournamentPaOverrides
      .filter((row) => row.needsUpdate)
      .map((row) => [String(row.id), row]),
  )
  const mergedTournamentPas = (tournamentPas || []).map((pa) => {
    const override = tournamentPaOverrideById[String(pa.id)]
    return override ? { ...pa, ...override } : pa
  })
  const tournamentExpectedByStintId = recomputePitchingByGame({
    games: games || [],
    pas: mergedTournamentPas,
    stints: tournamentPitchingStints || [],
    runs: tournamentRuns || [],
    pitches: tournamentPitches || [],
  })
  const seasonExpectedByStintId = recomputePitchingByGame({
    games: normalizedSeasonGames,
    pas: seasonPas || [],
    stints: seasonPitchingStints || [],
    runs: seasonRuns || [],
    pitches: seasonPitches || [],
  })

  const buildUpdates = (stints, expectedByStintId) => stints.map((stint) => {
    const expected = expectedByStintId[String(stint.id)] || {
      innings_pitched: 0,
      hits_allowed: 0,
      runs_allowed: 0,
      earned_runs: 0,
      walks: 0,
      strikeouts: 0,
      hr_allowed: 0,
      pitches_thrown: 0,
      strikes_thrown: 0,
    }
    const next = {
      id: stint.id,
      innings_pitched: expected.innings_pitched,
      hits_allowed: expected.hits_allowed,
      runs_allowed: expected.runs_allowed,
      earned_runs: expected.earned_runs,
      walks: expected.walks,
      strikeouts: expected.strikeouts,
      hr_allowed: expected.hr_allowed,
      pitches_thrown: expected.pitches_thrown,
      strikes_thrown: expected.strikes_thrown,
    }
    const needsUpdate =
      outsFromInningsPitched(stint.innings_pitched) !== outsFromInningsPitched(next.innings_pitched)
      || toNumber(stint.hits_allowed) !== toNumber(next.hits_allowed)
      || toNumber(stint.runs_allowed) !== toNumber(next.runs_allowed)
      || toNumber(stint.earned_runs) !== toNumber(next.earned_runs)
      || toNumber(stint.walks) !== toNumber(next.walks)
      || toNumber(stint.strikeouts) !== toNumber(next.strikeouts)
      || toNumber(stint.hr_allowed) !== toNumber(next.hr_allowed)
      || toNumber(stint.pitches_thrown) !== toNumber(next.pitches_thrown)
      || toNumber(stint.strikes_thrown) !== toNumber(next.strikes_thrown)

    return { ...next, needsUpdate }
  })

  const tournamentUpdates = buildUpdates(tournamentPitchingStints || [], tournamentExpectedByStintId)
  const seasonUpdates = buildUpdates(seasonPitchingStints || [], seasonExpectedByStintId)
  const tournamentCount = await applyRowUpdates('pitching_stints', tournamentUpdates, 'Tournament pitching stints')
  const seasonCount = await applyRowUpdates('season_pitching_stints', seasonUpdates, 'Season pitching stints')

  return {
    tournament_pitching_stints: tournamentCount,
    season_pitching_stints: seasonCount,
  }
}

async function main() {
  const seasonCount = await repairSeasonPlateAppearances()
  const tournamentResult = await repairTournamentOnePlateAppearances()
  const pitchingCounts = await repairPitchingStints({
    tournamentPaOverrides: tournamentResult.updates,
  })

  if (sqlFilePath) {
    const sql = [
      '-- Generated by scripts/repair_stats_integrity.mjs',
      'begin;',
      ...generatedSqlStatements,
      'commit;',
      '',
    ].join('\n')
    fs.mkdirSync(path.dirname(sqlFilePath), { recursive: true })
    fs.writeFileSync(sqlFilePath, sql, 'utf8')
    console.log(`Wrote SQL patch to ${sqlFilePath}`)
  }

  console.log(
    JSON.stringify(
        {
          applied: applyUpdates,
          season_plate_appearances: seasonCount,
          tournament_plate_appearances: tournamentResult.count,
          ...pitchingCounts,
        },
        null,
        2,
    ),
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
