import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient } from '@supabase/supabase-js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')
const workbookPathArg = process.argv[2]

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
const workbookPath = workbookPathArg
  ? path.resolve(repoRoot, workbookPathArg)
  : path.join(repoRoot, 'src', 'data', 'tournament1Workbook.json')
const tournament1Workbook = JSON.parse(fs.readFileSync(workbookPath, 'utf8'))

const DEFAULT_PLAYERS = [
  { name: 'Aidan', color: '#3B82F6' },
  { name: 'Donovan', color: '#F97316' },
  { name: 'Jason', color: '#22C55E' },
  { name: 'Justin', color: '#EF4444' },
  { name: 'May', color: '#A855F7' },
  { name: 'Nick', color: '#EC4899' }
]

const TOURNAMENT_ONE_NUMBER = 1
const TOURNAMENT_ONE_DATE = '2026-04-17'
const DEFAULT_TOURNAMENT_STATUS = 'complete'

function toNumber(value, fallback = 0) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function gameSortKey(code) {
  return Number(String(code || '').replace(/\D/g, '')) || 0
}

function parseWorkbookDraftRows() {
  return (tournament1Workbook.Data || [])
    .slice(2)
    .filter((row) => toNumber(row[0]) && toNumber(row[4]) === TOURNAMENT_ONE_NUMBER && toNumber(row[5]) === 1 && row[2] && row[3])
    .sort((a, b) => toNumber(a[0]) - toNumber(b[0]))
    .map((row) => ({
      pick_number: toNumber(row[0]),
      round: toNumber(row[1]),
      player_name: row[2],
      character_name: row[3]
    }))
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

function extractScorebookGames() {
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
    const sheetWinner = meta[21] || null
    const stage = meta[9] === 'CG-1' ? 'Championship' : meta[9]

    const teamABatting = []
    const teamBBatting = []
    const teamAPitching = []
    const teamBPitching = []

    const findSectionIndex = (label, startIndex) => {
      for (let cursor = startIndex; cursor < rows.length; cursor += 1) {
        if ((rows[cursor] || [])[0] === label) return cursor
        if (cursor > index + 1 && String((rows[cursor] || [])[0] || '').startsWith('Game ')) break
      }
      return -1
    }

    const parseBattingSection = (teamOwner, target, startIndex) => {
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

        target.push({
          game_code: gameCode,
          player_name: teamOwner,
          character_name: characterName,
          batting_order: battingOrder,
          at_bats: toNumber(battingRow[12]),
          runs: toNumber(battingRow[13]),
          hits: toNumber(battingRow[14]),
          doubles: toNumber(battingRow[15]),
          triples: toNumber(battingRow[16]),
          home_runs: toNumber(battingRow[17]),
          rbi: toNumber(battingRow[18]),
          walks: toNumber(battingRow[19]),
          strikeouts: toNumber(battingRow[20]),
          hbp: toNumber(battingRow[21]),
          sacrifice_flies: toNumber(battingRow[22]),
          sacrifice_hits: toNumber(battingRow[23]),
          plate_appearances: plateAppearances,
        })
        cursor += 1
      }
      return cursor
    }

    const parsePitchingSection = (teamOwner, target, startIndex) => {
      const sectionIndex = teamOwner ? findSectionIndex(`${teamOwner} Pitching`, startIndex) : -1
      if (sectionIndex === -1) return startIndex

      let cursor = sectionIndex + 2
      while (cursor < rows.length) {
        const pitchRow = rows[cursor] || []
        const slot = toNumber(pitchRow[0])
        const characterName = pitchRow[1]
        if (!slot || !characterName) break
        target.push({
          game_code: gameCode,
          player_name: teamOwner,
          character_name: characterName,
          innings_pitched: Number(pitchRow[2] || 0),
          hits_allowed: toNumber(pitchRow[3]),
          runs_allowed: toNumber(pitchRow[4]),
          earned_runs: toNumber(pitchRow[5]),
          walks: toNumber(pitchRow[6]),
          strikeouts: toNumber(pitchRow[7]),
          hr_allowed: toNumber(pitchRow[8]),
          win: toNumber(pitchRow[9]) === 1,
          loss: toNumber(pitchRow[10]) === 1,
          save: toNumber(pitchRow[11]) === 1,
          shutout: toNumber(pitchRow[12]) === 1,
          complete_game: toNumber(pitchRow[13]) === 1,
          pa: toNumber(pitchRow[14]),
        })
        cursor += 1
      }
      return cursor
    }

    let searchIndex = index + 2
    searchIndex = parseBattingSection(teamAOwner, teamABatting, searchIndex)
    searchIndex = parsePitchingSection(teamAOwner, teamAPitching, searchIndex)
    searchIndex = parseBattingSection(teamBOwner, teamBBatting, searchIndex)
    parsePitchingSection(teamBOwner, teamBPitching, searchIndex)

    const teamARuns = teamABatting.reduce((sum, item) => sum + item.runs, 0)
    const teamBRuns = teamBBatting.reduce((sum, item) => sum + item.runs, 0)

    games.push({
      game_code: gameCode,
      stage,
      team_a_owner: teamAOwner,
      team_b_owner: teamBOwner,
      winner_owner:
        teamARuns > teamBRuns
          ? teamAOwner
          : teamBRuns > teamARuns
            ? teamBOwner
            : sheetWinner,
      team_a_runs: teamARuns,
      team_b_runs: teamBRuns,
      status: teamARuns || teamBRuns || sheetWinner ? 'complete' : 'pending',
      battingRows: [...teamABatting, ...teamBBatting],
      pitchingRows: [...teamAPitching, ...teamBPitching],
    })
  }

  return games.sort((a, b) => gameSortKey(a.game_code) - gameSortKey(b.game_code))
}

function parseWorkbookGames() {
  return extractScorebookGames().map(({ battingRows, pitchingRows, ...game }) => game)
}

function parseWorkbookBattingRows() {
  return extractScorebookGames().flatMap((game) => game.battingRows)
}

function parseWorkbookPitchingRows() {
  return extractScorebookGames().flatMap((game) => game.pitchingRows)
}

async function insertInBatches(table, rows, batchSize = 200) {
  for (let index = 0; index < rows.length; index += batchSize) {
    const batch = rows.slice(index, index + batchSize)
    if (!batch.length) continue
    const { error } = await supabase.from(table).insert(batch)
    if (error) throw error
  }
}

async function syncFinalGameResults(parsedGames, gameMap, playerMap) {
  for (const game of parsedGames) {
    const dbGame = gameMap[game.game_code]
    if (!dbGame) continue
    const { error } = await supabase
      .from('games')
      .update({
        winner_player_id: game.winner_owner ? playerMap[game.winner_owner]?.id || null : null,
        team_a_runs: game.team_a_runs,
        team_b_runs: game.team_b_runs,
        status: game.status,
      })
      .eq('id', dbGame.id)
    if (error) throw error
  }
}

async function seedDefaultPlayers() {
  const { data: existingPlayers, error } = await supabase.from('players').select('*').order('name')
  if (error) throw error

  const existingNames = new Set((existingPlayers || []).map((player) => player.name.toLowerCase()))
  const missingPlayers = DEFAULT_PLAYERS.filter((player) => !existingNames.has(player.name.toLowerCase()))

  if (missingPlayers.length) {
    const { error: insertError } = await supabase.from('players').insert(
      missingPlayers.map((player) => ({ name: player.name, color: player.color }))
    )
    if (insertError) throw insertError
  }

  const { data: refreshedPlayers, error: refreshedError } = await supabase.from('players').select('*').order('name')
  if (refreshedError) throw refreshedError
  return refreshedPlayers || []
}

async function importTournamentOneWorkbook() {
  const { data: existingTournament, error: existingTournamentError } = await supabase
    .from('tournaments')
    .select('*')
    .eq('tournament_number', TOURNAMENT_ONE_NUMBER)
    .maybeSingle()

  if (existingTournamentError) throw existingTournamentError

  const players = await seedDefaultPlayers()
  const { data: characters, error: charactersError } = await supabase.from('characters').select('id, name')
  if (charactersError) throw charactersError

  const playerMap = Object.fromEntries(players.map((player) => [player.name, player]))
  const characterMap = Object.fromEntries(characters.map((character) => [character.name, character]))
  const championPlayerId = playerMap.Jason?.id || null

  let tournament = existingTournament

  if (existingTournament) {
    const { data: existingGames, error: existingGamesError } = await supabase
      .from('games')
      .select('id')
      .eq('tournament_id', existingTournament.id)
    if (existingGamesError) throw existingGamesError

    const gameIds = (existingGames || []).map((game) => game.id)
    if (gameIds.length) {
      for (const table of ['points_ledger', 'bets', 'pitching_stints', 'plate_appearances', 'lineups', 'inning_scores']) {
        const { error } = await supabase.from(table).delete().in('game_id', gameIds)
        if (error) throw error
      }
      const { error: deleteGamesError } = await supabase.from('games').delete().eq('tournament_id', existingTournament.id)
      if (deleteGamesError) throw deleteGamesError
    }

    const { error: deleteDraftError } = await supabase.from('draft_picks').delete().eq('tournament_id', existingTournament.id)
    if (deleteDraftError) throw deleteDraftError

    const { data: updatedTournament, error: updateTournamentError } = await supabase
      .from('tournaments')
      .update({
        date: TOURNAMENT_ONE_DATE,
        player_count: DEFAULT_PLAYERS.length,
        status: DEFAULT_TOURNAMENT_STATUS,
        champion_player_id: championPlayerId
      })
      .eq('id', existingTournament.id)
      .select()
      .single()
    if (updateTournamentError) throw updateTournamentError
    tournament = updatedTournament
  } else {
    const { data: createdTournament, error: tournamentError } = await supabase
      .from('tournaments')
      .insert({
        tournament_number: TOURNAMENT_ONE_NUMBER,
        date: TOURNAMENT_ONE_DATE,
        player_count: DEFAULT_PLAYERS.length,
        status: DEFAULT_TOURNAMENT_STATUS,
        champion_player_id: championPlayerId
      })
      .select()
      .single()
    if (tournamentError) throw tournamentError
    tournament = createdTournament
  }

  const draftRows = parseWorkbookDraftRows().map((row) => ({
    tournament_id: tournament.id,
    pick_number: row.pick_number,
    round: row.round,
    pick_in_round: ((row.pick_number - 1) % DEFAULT_PLAYERS.length) + 1,
    player_id: playerMap[row.player_name]?.id,
    character_id: characterMap[row.character_name]?.id
  }))
  await insertInBatches('draft_picks', draftRows, 100)

  const parsedGames = parseWorkbookGames()
  const gameRows = parsedGames.map((row) => ({
    tournament_id: tournament.id,
    game_code: row.game_code,
    stage: row.stage,
    team_a_player_id: playerMap[row.team_a_owner]?.id || null,
    team_b_player_id: playerMap[row.team_b_owner]?.id || null,
    winner_player_id: row.winner_owner ? playerMap[row.winner_owner]?.id || null : null,
    team_a_runs: row.team_a_runs,
    team_b_runs: row.team_b_runs,
    status: row.status
  }))
  await insertInBatches('games', gameRows, 50)

  const { data: insertedGames, error: insertedGamesError } = await supabase
    .from('games')
    .select('*')
    .eq('tournament_id', tournament.id)
    .order('id')
  if (insertedGamesError) throw insertedGamesError

  const gameMap = Object.fromEntries(insertedGames.map((game) => [game.game_code, game]))
  const battingRows = parseWorkbookBattingRows()

  const lineupRows = battingRows.map((row) => ({
    game_id: gameMap[row.game_code]?.id,
    player_id: playerMap[row.player_name]?.id,
    character_id: characterMap[row.character_name]?.id,
    batting_order: row.batting_order
  }))
  await insertInBatches('lineups', lineupRows, 200)

  const inningRows = parsedGames.flatMap((game) => {
    const dbGame = gameMap[game.game_code]
    if (!dbGame) return []
    return [
      { game_id: dbGame.id, player_id: dbGame.team_a_player_id, inning: 1, runs: game.team_a_runs },
      { game_id: dbGame.id, player_id: dbGame.team_b_player_id, inning: 1, runs: game.team_b_runs }
    ].filter((row) => row.player_id)
  })
  await insertInBatches('inning_scores', inningRows, 100)

  const plateAppearances = []
  const paCounters = {}
  battingRows.forEach((row) => {
    const dbGame = gameMap[row.game_code]
    const playerId = playerMap[row.player_name]?.id
    const characterId = characterMap[row.character_name]?.id
    if (!dbGame || !playerId || !characterId) return

    row.plate_appearances.forEach((appearance, index) => {
      paCounters[row.game_code] = (paCounters[row.game_code] || 0) + 1
      plateAppearances.push({
        game_id: dbGame.id,
        player_id: playerId,
        character_id: characterId,
        inning: Math.min(9, Math.floor(index / 3) + 1),
        pa_number: paCounters[row.game_code],
        result: appearance.result,
        rbi: appearance.rbi,
        run_scored: appearance.run_scored
      })
    })
  })
  await insertInBatches('plate_appearances', plateAppearances, 250)

  const pitchingRows = parseWorkbookPitchingRows()
    .map((row) => ({
      game_id: gameMap[row.game_code]?.id,
      player_id: playerMap[row.player_name]?.id,
      character_id: characterMap[row.character_name]?.id,
      innings_pitched: row.innings_pitched,
      hits_allowed: row.hits_allowed,
      runs_allowed: row.runs_allowed,
      earned_runs: row.earned_runs,
      walks: row.walks,
      strikeouts: row.strikeouts,
      hr_allowed: row.hr_allowed,
      win: row.win,
      loss: row.loss,
      save: row.save,
      shutout: row.shutout,
      complete_game: row.complete_game
    }))
    .filter((row) => row.game_id && row.player_id && row.character_id)
  await insertInBatches('pitching_stints', pitchingRows, 150)
  await syncFinalGameResults(parsedGames, gameMap, playerMap)

  return tournament
}

try {
  const tournament = await importTournamentOneWorkbook()
  console.log(`Imported Tournament ${TOURNAMENT_ONE_NUMBER} into Supabase as ${tournament.id}`)
} catch (error) {
  console.error(error?.message || error)
  process.exitCode = 1
}
