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
const tournament1Workbook = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src', 'data', 'tournament1Workbook.json'), 'utf8'))
const RESULT_OUTS = new Set(['K', 'GO', 'FO', 'LO', 'SF', 'SH'])

function toNumber(value, fallback = 0) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function calculateOutsForPa(result, outsOnPlay = null) {
  if (outsOnPlay != null) return Number(outsOnPlay)
  if (result === 'TP') return 3
  if (result === 'DP') return 2
  if (result === 'FC') return 1
  return RESULT_OUTS.has(result) ? 1 : 0
}

function sortByChronology(rows = []) {
  return [...rows].sort((a, b) => {
    const paA = Number.isFinite(Number(a.pa_number)) ? Number(a.pa_number) : Number.POSITIVE_INFINITY
    const paB = Number.isFinite(Number(b.pa_number)) ? Number(b.pa_number) : Number.POSITIVE_INFINITY
    if (paA !== paB) return paA - paB

    const createdA = a.created_at ? new Date(a.created_at).getTime() : 0
    const createdB = b.created_at ? new Date(b.created_at).getTime() : 0
    if (createdA !== createdB) return createdA - createdB

    return Number(a.id || 0) - Number(b.id || 0)
  })
}

function buildRunner(playerId, characterId) {
  return playerId == null || characterId == null
    ? null
    : { playerId, characterId }
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
  return ['first', 'second', 'third', 'batter'].reduce((total, slot) => (
    participants[slot] && destinations[slot] === 'home' ? total + 1 : total
  ), 0)
}

function countOutDestinations(destinations, participants) {
  return ['first', 'second', 'third', 'batter'].reduce((total, slot) => (
    participants[slot] && destinations[slot] === 'out' ? total + 1 : total
  ), 0)
}

function getRecordedRuns(record = {}, runEvents = []) {
  if (runEvents.length) return runEvents.length
  const isHr = record.result === 'HR' || record.result === 'IPHR'
  return Number(record.rbi || 0) + (record.run_scored && !isHr ? 1 : 0)
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

function applyRunAdjustments({ result, bases, batter, batterScored, destinations, runEvents, totalRuns, warnings, label }) {
  const participants = { ...bases, batter }
  const explicitScorers = new Set()

  runEvents.forEach((run) => {
    const matchedSlot = ['first', 'second', 'third'].find((slot) => runnerMatchesEvent(participants[slot], run))
    if (matchedSlot) {
      destinations[matchedSlot] = 'home'
      explicitScorers.add(matchedSlot)
      return
    }
    if (runnerMatchesEvent(batter, run)) {
      destinations.batter = 'home'
      explicitScorers.add('batter')
      return
    }
    warnings.push(`${label}: unmatched run event for scorer ${run.scoring_character_id}/${run.scoring_player_id}`)
  })

  if (batterScored && batter) {
    destinations.batter = 'home'
    explicitScorers.add('batter')
  }

  if (batter && destinations.batter !== 'home' && destinations.batter !== 'out' && totalRuns > countHomeDestinations(destinations, participants) && result === 'IPHR') {
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
  return needed
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

function replayEntries(entries = [], labelPrefix = '') {
  let bases = { first: null, second: null, third: null }
  let outsInHalf = 0
  const warnings = []
  const updates = []

  entries.forEach((entry, index) => {
    const label = `${labelPrefix}${entry.game_id || ''}#${entry.id || index}`
    updates.push({
      id: entry.id,
      ...occupiedFlags(bases),
    })

    const batter = buildRunner(entry.player_id, entry.character_id)
    const runEvents = entry.runEvents || []
    const totalRuns = getRecordedRuns(entry, runEvents)
    const outsTarget = calculateOutsForPa(entry.result, entry.outs_on_play)
    const destinations = defaultDestinationsForResult(entry.result, bases)
    const explicitScorers = applyRunAdjustments({
      result: entry.result,
      bases,
      batter,
      batterScored: Boolean(entry.run_scored),
      destinations,
      runEvents,
      totalRuns,
      warnings,
      label,
    })

    applyRunDemotions({
      result: entry.result,
      bases,
      batter,
      destinations,
      totalRuns,
      outsTarget,
      explicitScorers,
    })

    const unresolvedOuts = applyExtraOuts({
      result: entry.result,
      bases,
      batter,
      destinations,
      outsTarget,
    })
    if (unresolvedOuts > 0) {
      warnings.push(`${label}: could not assign ${unresolvedOuts} recorded out(s) to runners`)
    }

    const resultingRuns = countHomeDestinations(destinations, { ...bases, batter })
    if (resultingRuns !== totalRuns) {
      warnings.push(`${label}: replay assigned ${resultingRuns} run(s), source recorded ${totalRuns}`)
    }

    bases = materializeNextBases(destinations, bases, batter)
    outsInHalf += outsTarget
    if (outsInHalf >= 3) {
      outsInHalf = 0
      bases = { first: null, second: null, third: null }
    }
  })

  return { updates, warnings }
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

function gameSortKey(code) {
  return Number(String(code || '').replace(/\D/g, '')) || 0
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

    let searchIndex = index + 2
    searchIndex = parseBattingSection(teamAOwner, searchIndex)
    parseBattingSection(teamBOwner, searchIndex)

    games.push({
      game_code: gameCode,
      team_a_owner: teamAOwner,
      team_b_owner: teamBOwner,
      battingRows,
    })
  }

  return games.sort((a, b) => gameSortKey(a.game_code) - gameSortKey(b.game_code))
}

function countRemainingAppearances(teamState) {
  return teamState.lineup.reduce((total, row) => total + Math.max(0, row.plate_appearances.length - teamState.nextIndexByOrder[row.batting_order]), 0)
}

function buildTournamentOneChronologicalEntries({ workbookGame, dbGame, playerByName, characterByName, dbRowsByBatterKey }) {
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
  const totalExpectedPas = [...topState.lineup, ...bottomState.lineup].reduce((total, row) => total + row.plate_appearances.length, 0)
  const entries = []
  let isTop = true
  let outsInHalf = 0

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
        outsInHalf = 0
        isTop = !isTop
        continue
      }
      throw new Error(`Tournament 1 replay lost chronology at ${workbookGame.game_code}, batting order ${batterRow.batting_order}`)
    }

    const playerId = playerByName[batterRow.player_name]?.id
    const characterId = characterByName[batterRow.character_name]?.id
    const key = `${dbGame.id}:${playerId}:${characterId}`
    const dbRows = dbRowsByBatterKey[key] || []
    const dbRow = dbRows[appearanceIndex]
    if (!dbRow) {
      throw new Error(`No DB PA row matched ${workbookGame.game_code} ${batterRow.player_name}/${batterRow.character_name} PA ${appearanceIndex + 1}`)
    }

    if (
      String(dbRow.result || '') !== String(appearance.result || '')
      || Number(dbRow.rbi || 0) !== Number(appearance.rbi || 0)
      || Boolean(dbRow.run_scored) !== Boolean(appearance.run_scored)
    ) {
      throw new Error(`DB/workbook mismatch for ${workbookGame.game_code} ${batterRow.player_name}/${batterRow.character_name} PA ${appearanceIndex + 1}`)
    }

    entries.push({
      id: dbRow.id,
      game_id: dbRow.game_id,
      player_id: dbRow.player_id,
      character_id: dbRow.character_id,
      result: dbRow.result,
      rbi: dbRow.rbi,
      run_scored: dbRow.run_scored,
      outs_on_play: dbRow.outs_on_play,
      runEvents: [],
    })

    activeState.nextIndexByOrder[batterRow.batting_order] = appearanceIndex + 1
    activeState.cursor = (activeState.cursor + 1) % activeState.lineup.length

    outsInHalf += calculateOutsForPa(dbRow.result, dbRow.outs_on_play)
    if (outsInHalf >= 3) {
      outsInHalf = 0
      isTop = !isTop
    }
  }

  if (entries.length !== totalExpectedPas) {
    throw new Error(`Tournament 1 replay produced ${entries.length} entries, expected ${totalExpectedPas} for ${workbookGame.game_code}`)
  }

  return entries
}

function groupBy(rows = [], keyFn) {
  return rows.reduce((acc, row) => {
    const key = keyFn(row)
    if (!acc[key]) acc[key] = []
    acc[key].push(row)
    return acc
  }, {})
}

function summarizeTarget(label, updates, warnings) {
  const changed = updates.filter((row) => row.needsUpdate)
  return {
    label,
    totalRows: updates.length,
    changedRows: changed.length,
    warningCount: warnings.length,
  }
}

async function applyGroupedUpdates(table, updates) {
  const changed = updates.filter((row) => row.needsUpdate)
  const groups = groupBy(changed, (row) => (
    `${row.runner_on_first_before}:${row.runner_on_second_before}:${row.runner_on_third_before}`
  ))

  for (const [key, rows] of Object.entries(groups)) {
    const [runner_on_first_before, runner_on_second_before, runner_on_third_before] = key.split(':').map((value) => value === 'true')
    for (let index = 0; index < rows.length; index += 200) {
      const batch = rows.slice(index, index + 200)
      const { error } = await supabase
        .from(table)
        .update({ runner_on_first_before, runner_on_second_before, runner_on_third_before })
        .in('id', batch.map((row) => row.id))
      if (error) throw error
    }
  }
}

function buildSqlForUpdates(table, updates = []) {
  const changed = updates.filter((row) => row.needsUpdate)
  const groups = groupBy(changed, (row) => (
    `${row.runner_on_first_before}:${row.runner_on_second_before}:${row.runner_on_third_before}`
  ))

  return Object.entries(groups).flatMap(([key, rows]) => {
    const [runner_on_first_before, runner_on_second_before, runner_on_third_before] = key.split(':').map((value) => value === 'true')
    const statements = []
    for (let index = 0; index < rows.length; index += 200) {
      const batch = rows.slice(index, index + 200)
      statements.push(
        `update public.${table}
set runner_on_first_before = ${runner_on_first_before ? 'true' : 'false'},
    runner_on_second_before = ${runner_on_second_before ? 'true' : 'false'},
    runner_on_third_before = ${runner_on_third_before ? 'true' : 'false'}
where id in (${batch.map((row) => row.id).join(', ')});`,
      )
    }
    return statements
  })
}

function mergeReplayWithExistingRows(replayUpdates = [], existingRowsById = {}) {
  return replayUpdates.map((row) => {
    const current = existingRowsById[String(row.id)] || {}
    const needsUpdate =
      current.runner_on_first_before !== row.runner_on_first_before
      || current.runner_on_second_before !== row.runner_on_second_before
      || current.runner_on_third_before !== row.runner_on_third_before

    return { ...row, needsUpdate }
  })
}

async function backfillSeasonOne() {
  const { data: seasons, error: seasonsError } = await supabase
    .from('seasons')
    .select('id,name,created_at')
    .order('created_at', { ascending: true })
  if (seasonsError) throw seasonsError

  const seasonOne = (seasons || []).find((season) => /\bseason\s*1\b/i.test(String(season.name || '')))
  if (!seasonOne) {
    return { label: 'MSL 1', totalRows: 0, changedRows: 0, warningCount: 1, warnings: ['MSL 1 season not found'] }
  }

  const [
    { data: seasonGames, error: gamesError },
    { data: seasonPas, error: pasError },
    { data: seasonRuns, error: runsError },
  ] = await Promise.all([
    supabase.from('season_schedule').select('id').eq('season_id', seasonOne.id).order('id'),
    supabase.from('season_plate_appearances').select('id,game_id,player_id,character_id,result,rbi,run_scored,outs_on_play,pa_number,created_at,runner_on_first_before,runner_on_second_before,runner_on_third_before').eq('season_id', seasonOne.id).order('created_at'),
    supabase.from('season_runs_scored').select('id,game_id,pa_id,scoring_player_id,scoring_character_id').eq('season_id', seasonOne.id).order('created_at'),
  ])
  if (gamesError) throw gamesError
  if (pasError) throw pasError
  if (runsError) throw runsError

  const runsByPaId = groupBy(seasonRuns || [], (run) => String(run.pa_id))
  const pasByGame = groupBy(seasonPas || [], (pa) => String(pa.game_id))
  const existingRowsById = Object.fromEntries((seasonPas || []).map((row) => [String(row.id), row]))

  const replayUpdates = []
  const warnings = []
  ;(seasonGames || []).forEach((game) => {
    const orderedPas = sortByChronology((pasByGame[String(game.id)] || []).map((pa) => ({
      ...pa,
      runEvents: runsByPaId[String(pa.id)] || [],
    })))
    const replay = replayEntries(orderedPas, `MSL1 game ${game.id}:`)
    replayUpdates.push(...replay.updates)
    warnings.push(...replay.warnings)
  })

  const merged = mergeReplayWithExistingRows(replayUpdates, existingRowsById)
  if (applyUpdates) {
    await applyGroupedUpdates('season_plate_appearances', merged)
  }

  return {
    ...summarizeTarget(`MSL 1 (${seasonOne.name})`, merged, warnings),
    table: 'season_plate_appearances',
    updates: merged,
    warnings,
  }
}

async function backfillTournamentOne() {
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
    return { label: 'MST 1', totalRows: 0, changedRows: 0, warningCount: 1, warnings: ['MST 1 tournament not found'] }
  }

  const { data: games, error: gamesError } = await supabase
    .from('games')
    .select('id,game_code')
    .eq('tournament_id', tournament.id)
    .order('id')
  if (gamesError) throw gamesError

  const gameIds = (games || []).map((game) => game.id)
  let tournamentPas = []
  if (gameIds.length) {
    const { data, error } = await supabase
      .from('plate_appearances')
      .select('id,game_id,player_id,character_id,result,rbi,run_scored,outs_on_play,pa_number,created_at,runner_on_first_before,runner_on_second_before,runner_on_third_before')
      .in('game_id', gameIds)
      .order('created_at')
    if (error) throw error
    tournamentPas = data || []
  }

  const playerByName = Object.fromEntries((players || []).map((player) => [player.name, player]))
  const characterByName = Object.fromEntries((characters || []).map((character) => [character.name, character]))
  const dbGameByCode = Object.fromEntries((games || []).map((game) => [game.game_code, game]))
  const dbRowsByBatterKey = Object.fromEntries(
    Object.entries(groupBy(tournamentPas, (pa) => `${pa.game_id}:${pa.player_id}:${pa.character_id}`))
      .map(([key, rows]) => [key, sortByChronology(rows)]),
  )
  const existingRowsById = Object.fromEntries(tournamentPas.map((row) => [String(row.id), row]))

  const replayUpdates = []
  const warnings = []
  extractTournamentOneWorkbookGames().forEach((workbookGame) => {
    const dbGame = dbGameByCode[workbookGame.game_code]
    if (!dbGame) {
      warnings.push(`MST1 ${workbookGame.game_code}: no matching DB game`)
      return
    }
    const chronologicalEntries = buildTournamentOneChronologicalEntries({
      workbookGame,
      dbGame,
      playerByName,
      characterByName,
      dbRowsByBatterKey,
    })
    const replay = replayEntries(chronologicalEntries, `MST1 ${workbookGame.game_code}:`)
    replayUpdates.push(...replay.updates)
    warnings.push(...replay.warnings)
  })

  const merged = mergeReplayWithExistingRows(replayUpdates, existingRowsById)
  if (applyUpdates) {
    await applyGroupedUpdates('plate_appearances', merged)
  }

  return {
    ...summarizeTarget('MST 1', merged, warnings),
    table: 'plate_appearances',
    updates: merged,
    warnings,
  }
}

async function main() {
  const results = await Promise.all([
    backfillTournamentOne(),
    backfillSeasonOne(),
  ])

  if (sqlFilePath) {
    const statements = results.flatMap((result) => buildSqlForUpdates(result.table, result.updates))
    const sql = [
      '-- Generated by scripts/backfill_risp_flags.mjs',
      'begin;',
      ...statements,
      'commit;',
      '',
    ].join('\n')
    fs.mkdirSync(path.dirname(sqlFilePath), { recursive: true })
    fs.writeFileSync(sqlFilePath, sql, 'utf8')
    console.log(`Wrote SQL backfill patch to ${sqlFilePath}`)
  }

  results.forEach((result) => {
    console.log(`${applyUpdates ? 'Applied' : 'Prepared'} ${result.changedRows}/${result.totalRows} ${result.label} rows (${result.warningCount} warning(s))`)
    result.warnings.slice(0, 25).forEach((warning) => console.log(`  - ${warning}`))
    if (result.warnings.length > 25) {
      console.log(`  - ... ${result.warnings.length - 25} more warning(s)`)
    }
  })
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
