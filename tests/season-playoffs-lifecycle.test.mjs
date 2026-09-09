import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSeasonStandings } from '../src/utils/competitionStandings.js'
import {
  completeSeasonGameLifecycle,
  deriveSeasonPlayoffUiState,
  reopenSeasonGameLifecycle,
  resolveSeasonScorebookGameId,
  seedSeasonPlayoffs,
  sortSeasonPlayoffGames,
} from '../src/utils/seasonPlayoffs.js'
import {
  buildFourTeamSeasonFixture,
  createSeasonFakeSupabase,
  playoffRows,
  rowForStage,
  setGameReopened,
} from './helpers/seasonFakeSupabase.mjs'

function currentSeason(client) {
  return { ...client.db.seasons[0] }
}

async function completeGame(client, game, winner = 'home') {
  assert.ok(game, 'game must exist before completion')
  await completeSeasonGameLifecycle({
    supabase: client,
    season: currentSeason(client),
    selectedGame: { ...game },
    scores: winner === 'home' ? { a: 1, b: 4 } : { a: 4, b: 1 },
  })
  return client.db.season_schedule.find((entry) => entry.id === game.id)
}

async function finishRegularSeason(client) {
  return completeGame(client, client.db.season_schedule.find((game) => !game.stage && game.status !== 'completed'), 'home')
}

function assertUniqueStages(client, expectedCount) {
  const rows = playoffRows(client)
  assert.equal(rows.length, expectedCount)
  assert.equal(new Set(rows.map((game) => game.stage)).size, expectedCount)
}

async function playDoubleEliminationToChampionship(client) {
  await finishRegularSeason(client)
  let ui = deriveSeasonPlayoffUiState({ schedule: client.db.season_schedule, playoffFormat: 'double_elimination', teamCount: 4, seasonStatus: 'playoffs' })
  assert.equal(ui.metaByGameId[String(rowForStage(client, 'Winners R1-1').id)].canStartGame, true)
  assert.equal(ui.metaByGameId[String(rowForStage(client, 'Winners R1-2').id)].canStartGame, false)
  await completeGame(client, rowForStage(client, 'Winners R1-1'), 'home')
  await completeGame(client, rowForStage(client, 'Winners R1-2'), 'home')
  assert.deepEqual([rowForStage(client, 'Losers R1-1').home_team_id, rowForStage(client, 'Losers R1-1').away_team_id], [4, 3])
  await completeGame(client, rowForStage(client, 'Losers R1-1'), 'home')
  assert.deepEqual([rowForStage(client, 'Winners Final').home_team_id, rowForStage(client, 'Winners Final').away_team_id], [1, 2])
  await completeGame(client, rowForStage(client, 'Winners Final'), 'home')
  assert.deepEqual([rowForStage(client, 'Losers Final').home_team_id, rowForStage(client, 'Losers Final').away_team_id], [2, 4])
  await completeGame(client, rowForStage(client, 'Losers Final'), 'home')
  ui = deriveSeasonPlayoffUiState({ schedule: client.db.season_schedule, playoffFormat: 'double_elimination', teamCount: 4, seasonStatus: 'playoffs' })
  assert.equal(ui.metaByGameId[String(rowForStage(client, 'Championship').id)].canStartGame, true)
  return rowForStage(client, 'Championship')
}

test('two-team head-to-head outranks betting winnings', () => {
  const teams = [
    { id: 'a', player_id: 'pa', team_name: 'Alpha' },
    { id: 'b', player_id: 'pb', team_name: 'Beta' },
    { id: 'c', player_id: 'pc', team_name: 'Charlie' },
    { id: 'd', player_id: 'pd', team_name: 'Delta' },
  ]
  const games = [
    { status: 'completed', home_team_id: 'a', away_team_id: 'b', winner_team_id: 'a', home_score: 2, away_score: 1 },
    { status: 'completed', home_team_id: 'c', away_team_id: 'a', winner_team_id: 'c', home_score: 2, away_score: 1 },
    { status: 'completed', home_team_id: 'b', away_team_id: 'd', winner_team_id: 'b', home_score: 2, away_score: 1 },
  ]
  const ledger = [{ player_id: 'pb', dollars_change: 1000 }]
  const tied = buildSeasonStandings(teams, games, ledger).filter((team) => ['a', 'b'].includes(team.id))
  assert.deepEqual(tied.map((team) => team.id), ['a', 'b'])
})

test('an exactly tied two-team head-to-head record falls through to betting winnings', () => {
  const teams = [
    { id: 'a', player_id: 'pa', team_name: 'Alpha' },
    { id: 'b', player_id: 'pb', team_name: 'Beta' },
  ]
  const games = [
    { status: 'completed', home_team_id: 'a', away_team_id: 'b', winner_team_id: 'a', home_score: 2, away_score: 1 },
    { status: 'completed', home_team_id: 'b', away_team_id: 'a', winner_team_id: 'b', home_score: 2, away_score: 1 },
  ]
  const standings = buildSeasonStandings(teams, games, [{ player_id: 'pb', dollars_change: 1 }])
  assert.deepEqual(standings.map((team) => team.id), ['b', 'a'])
})

test('three-way circular tie falls through to betting, then deterministic exact-equality fallbacks', () => {
  const teams = [
    { id: 'c', player_id: 'pc', team_name: 'Same' },
    { id: 'a', player_id: 'pa', team_name: 'Same' },
    { id: 'b', player_id: 'pb', team_name: 'Same' },
  ]
  const games = [
    { status: 'completed', home_team_id: 'a', away_team_id: 'b', winner_team_id: 'a', home_score: 2, away_score: 1 },
    { status: 'completed', home_team_id: 'b', away_team_id: 'c', winner_team_id: 'b', home_score: 2, away_score: 1 },
    { status: 'completed', home_team_id: 'c', away_team_id: 'a', winner_team_id: 'c', home_score: 2, away_score: 1 },
    // Missing-team rows are ignored rather than corrupting a real team's totals.
    { status: 'completed', home_team_id: 'missing', away_team_id: 'a', winner_team_id: 'missing', home_score: 9, away_score: 0 },
  ]
  const bettingOrder = buildSeasonStandings(teams, games, [
    { player_id: 'pc', dollars_change: 20 },
    { player_id: 'pb', dollars_change: 10 },
    { player_id: 'pa', dollars_change: 0 },
  ])
  assert.deepEqual(bettingOrder.map((team) => team.id), ['c', 'b', 'a'])

  const equalOrderA = buildSeasonStandings(teams, games, [{ player_id: 'pa', dollars_change: 'not-a-number' }])
  const equalOrderB = buildSeasonStandings([...teams].reverse(), [...games].reverse(), [])
  assert.deepEqual(equalOrderA.map((team) => team.id), ['a', 'b', 'c'])
  assert.deepEqual(equalOrderB.map((team) => team.id), ['a', 'b', 'c'])
})

test('two clients completing the last regular-season game claim one single-elimination bracket', async () => {
  const fixture = buildFourTeamSeasonFixture({ playoffFormat: 'single_elimination' })
  const client = createSeasonFakeSupabase(fixture.tables)
  const lastGame = client.db.season_schedule.find((game) => game.status === 'scheduled')

  await Promise.all([
    completeSeasonGameLifecycle({ supabase: client, season: { ...fixture.season }, selectedGame: { ...lastGame }, scores: { a: 1, b: 4 } }),
    completeSeasonGameLifecycle({ supabase: client, season: { ...fixture.season }, selectedGame: { ...lastGame }, scores: { a: 1, b: 4 } }),
  ])

  assert.equal(client.db.seasons[0].status, 'playoffs')
  assertUniqueStages(client, 3)
  assert.deepEqual(playoffRows(client).filter((game) => game.stage.startsWith('Round 1')).map((game) => [game.home_team_id, game.away_team_id]), [[1, 4], [2, 3]])
})

test('partial playoff initialization retries from persisted rows without duplicates', async () => {
  const fixture = buildFourTeamSeasonFixture({ playoffFormat: 'single_elimination' })
  const failure = { action: 'insert', table: 'season_schedule', occurrence: 2, message: 'second bracket insert failed' }
  const client = createSeasonFakeSupabase(fixture.tables, { failures: [failure] })
  const lastGame = client.db.season_schedule.find((game) => game.status === 'scheduled')

  await assert.rejects(
    completeSeasonGameLifecycle({ supabase: client, season: currentSeason(client), selectedGame: { ...lastGame }, scores: { a: 1, b: 4 } }),
    /second bracket insert failed/,
  )
  assert.equal(client.db.seasons[0].status, 'playoffs')
  assert.equal(playoffRows(client).length, 1)

  await completeSeasonGameLifecycle({
    supabase: client,
    season: currentSeason(client),
    selectedGame: { ...lastGame },
    scores: { a: 1, b: 4 },
  })
  assertUniqueStages(client, 3)

  // A stale retry snapshot is harmless because seeding reloads persisted rows.
  await seedSeasonPlayoffs({ supabase: client, season: currentSeason(client), standings: buildSeasonStandings(client.db.season_teams, client.db.season_schedule, []), schedule: fixture.schedule })
  assertUniqueStages(client, 3)
})

test('reopening the last regular-season game removes stale seeding and opposite recompletion reseeds once', async () => {
  const fixture = buildFourTeamSeasonFixture({ playoffFormat: 'single_elimination' })
  const client = createSeasonFakeSupabase(fixture.tables)
  const lastGame = await finishRegularSeason(client)
  assertUniqueStages(client, 3)

  const reopened = setGameReopened(client, lastGame.id)
  await reopenSeasonGameLifecycle({ supabase: client, season: currentSeason(client), selectedGame: reopened })
  assert.equal(client.db.seasons[0].status, 'active')
  assert.equal(playoffRows(client).length, 0)

  await completeGame(client, reopened, 'away')
  assert.equal(client.db.seasons[0].status, 'playoffs')
  assertUniqueStages(client, 3)
  assert.deepEqual([rowForStage(client, 'Round 1-2').home_team_id, rowForStage(client, 'Round 1-2').away_team_id], [3, 2])
})

test('single-elimination UI state progresses, supports early home stadium setup, and records champion', async () => {
  const fixture = buildFourTeamSeasonFixture({ playoffFormat: 'single_elimination' })
  const client = createSeasonFakeSupabase(fixture.tables)
  await finishRegularSeason(client)

  let ui = deriveSeasonPlayoffUiState({ schedule: [...client.db.season_schedule].reverse(), playoffFormat: 'single_elimination', teamCount: 4, seasonStatus: 'playoffs' })
  assert.deepEqual(ui.orderedGames.map((game) => game.stage), ['Round 1-1', 'Round 1-2', 'Round 2-1'])
  assert.deepEqual(ui.visibleGames.map((game) => game.stage), ['Round 1-1', 'Round 1-2'])
  assert.equal(ui.metaByGameId[String(rowForStage(client, 'Round 1-1').id)].canStartGame, true)
  assert.match(ui.metaByGameId[String(rowForStage(client, 'Round 1-2').id)].lockReason, /Round 1-1/)

  await completeGame(client, rowForStage(client, 'Round 1-1'), 'home')
  const final = rowForStage(client, 'Round 2-1')
  assert.equal(final.home_team_id, 1)
  assert.equal(final.away_team_id, null)
  ui = deriveSeasonPlayoffUiState({ schedule: client.db.season_schedule, playoffFormat: 'single_elimination', teamCount: 4, seasonStatus: 'playoffs' })
  assert.equal(ui.metaByGameId[String(final.id)].canSelectStadium, true)
  assert.equal(ui.metaByGameId[String(final.id)].canStartGame, false)

  final.stadium = 'Bowser Castle'
  await completeGame(client, rowForStage(client, 'Round 1-2'), 'home')
  assert.equal(rowForStage(client, 'Round 2-1').stadium, 'Bowser Castle', 'stable home slot keeps its early stadium choice')
  await completeGame(client, rowForStage(client, 'Round 2-1'), 'home')
  assert.equal(client.db.seasons[0].status, 'completed')
  assert.equal(client.db.seasons[0].champion_player_id, 'player-1')
  assertUniqueStages(client, 3)
})

test('double elimination completes without reset when winners-side finalist wins', async () => {
  const fixture = buildFourTeamSeasonFixture({ playoffFormat: 'double_elimination' })
  const client = createSeasonFakeSupabase(fixture.tables)
  const championship = await playDoubleEliminationToChampionship(client)
  await completeGame(client, championship, 'home')

  assert.equal(rowForStage(client, 'Championship Reset'), null)
  assert.equal(client.db.seasons[0].status, 'completed')
  assert.equal(client.db.seasons[0].champion_player_id, 'player-1')
  assertUniqueStages(client, 6)
})

test('double elimination creates and resolves a required championship reset exactly once', async () => {
  const fixture = buildFourTeamSeasonFixture({ playoffFormat: 'double_elimination' })
  const client = createSeasonFakeSupabase(fixture.tables)
  const championship = await playDoubleEliminationToChampionship(client)
  await completeGame(client, championship, 'away')

  const reset = rowForStage(client, 'Championship Reset')
  assert.ok(reset)
  assert.equal(client.db.seasons[0].status, 'playoffs')
  assert.deepEqual([reset.home_team_id, reset.away_team_id], [championship.home_team_id, championship.away_team_id])

  await completeGame(client, reset, 'away')
  await completeGame(client, reset, 'away')
  assert.equal(client.db.seasons[0].status, 'completed')
  assert.equal(client.db.seasons[0].champion_player_id, 'player-2')
  assertUniqueStages(client, 7)
})

test('reopening an early playoff invalidates downstream data and opposite recompletion advances safely', async () => {
  const fixture = buildFourTeamSeasonFixture({ playoffFormat: 'single_elimination' })
  const client = createSeasonFakeSupabase(fixture.tables)
  await finishRegularSeason(client)
  await completeGame(client, rowForStage(client, 'Round 1-1'), 'home')
  await completeGame(client, rowForStage(client, 'Round 1-2'), 'home')
  await completeGame(client, rowForStage(client, 'Round 2-1'), 'home')
  const final = rowForStage(client, 'Round 2-1')
  client.db.season_plate_appearances.push({ id: 1, season_id: 1, game_id: final.id })

  const reopened = setGameReopened(client, rowForStage(client, 'Round 1-1').id)
  await reopenSeasonGameLifecycle({ supabase: client, season: currentSeason(client), selectedGame: reopened })
  await reopenSeasonGameLifecycle({ supabase: client, season: currentSeason(client), selectedGame: reopened })

  assert.equal(client.db.seasons[0].status, 'playoffs')
  assert.equal(client.db.seasons[0].champion_player_id, null)
  assert.equal(final.status, 'scheduled')
  assert.equal(final.home_team_id, null)
  assert.equal(final.away_team_id, 2)
  assert.equal(client.db.season_plate_appearances.length, 0)

  await completeGame(client, rowForStage(client, 'Round 1-1'), 'away')
  assert.equal(final.home_team_id, 4)
  assert.equal(final.away_team_id, 2)
  assert.equal(final.status, 'scheduled')
  assertUniqueStages(client, 3)
})

test('downstream cleanup failure preserves the completed row and a retry finishes invalidation', async () => {
  const fixture = buildFourTeamSeasonFixture({ playoffFormat: 'single_elimination' })
  const failure = { action: 'delete', table: 'season_plate_appearances', occurrence: 1, message: 'cleanup temporarily failed' }
  const client = createSeasonFakeSupabase(fixture.tables, { failures: [failure] })
  await finishRegularSeason(client)
  await completeGame(client, rowForStage(client, 'Round 1-1'), 'home')
  await completeGame(client, rowForStage(client, 'Round 1-2'), 'home')
  await completeGame(client, rowForStage(client, 'Round 2-1'), 'home')
  const final = rowForStage(client, 'Round 2-1')
  client.db.season_plate_appearances.push({ id: 1, season_id: 1, game_id: final.id })
  const reopened = setGameReopened(client, rowForStage(client, 'Round 1-1').id)

  await assert.rejects(
    reopenSeasonGameLifecycle({ supabase: client, season: currentSeason(client), selectedGame: reopened }),
    /cleanup temporarily failed/,
  )
  assert.equal(final.status, 'completed')
  assert.equal(final.winner_team_id, 1)

  await reopenSeasonGameLifecycle({ supabase: client, season: currentSeason(client), selectedGame: reopened })
  assert.equal(final.status, 'scheduled')
  assert.equal(final.winner_team_id, null)
  assert.equal(client.db.seasons[0].status, 'playoffs')
})

test('locked and hidden playoff query parameters cannot select Scorebook games', async () => {
  const fixture = buildFourTeamSeasonFixture({ playoffFormat: 'single_elimination' })
  const client = createSeasonFakeSupabase(fixture.tables)
  await finishRegularSeason(client)
  const first = rowForStage(client, 'Round 1-1')
  const second = rowForStage(client, 'Round 1-2')
  const hiddenFinal = rowForStage(client, 'Round 2-1')
  const input = { schedule: client.db.season_schedule, playoffFormat: 'single_elimination', teamCount: 4, seasonStatus: 'playoffs' }

  assert.equal(resolveSeasonScorebookGameId({ ...input, requestedGameId: first.id }), first.id)
  assert.equal(resolveSeasonScorebookGameId({ ...input, requestedGameId: second.id }), 0)
  assert.equal(resolveSeasonScorebookGameId({ ...input, requestedGameId: hiddenFinal.id }), 0)
  assert.equal(resolveSeasonScorebookGameId({ ...input, requestedGameId: 999999 }), 0)

  const staleOutOfOrder = client.db.season_schedule.map((game) => (
    game.stage === 'Round 1-2' ? { ...game, status: 'completed', winner_team_id: game.home_team_id } : game
  ))
  const staleUi = deriveSeasonPlayoffUiState({ ...input, schedule: staleOutOfOrder })
  assert.match(staleUi.metaByGameId[String(hiddenFinal.id)].lockReason, /Round 1-1/)
})

test('single-elimination byes resolve into a progressive final and duplicate/out-of-order rows stay canonical', async () => {
  const season = { id: 2, status: 'playoffs', playoff_format: 'single_elimination', innings: 6 }
  const teams = [1, 2, 3].map((id) => ({ id, season_id: 2, player_id: `p${id}`, team_name: `T${id}` }))
  const client = createSeasonFakeSupabase({ seasons: [season], season_teams: teams, season_schedule: [] })
  const standings = teams.map((team, index) => ({ ...team, rank: index + 1 }))
  await seedSeasonPlayoffs({ supabase: client, season, standings, schedule: [] })

  assertUniqueStages(client, 2)
  assert.deepEqual([rowForStage(client, 'Round 1-1').home_team_id, rowForStage(client, 'Round 1-1').away_team_id], [2, 3])
  assert.deepEqual([rowForStage(client, 'Round 2-1').home_team_id, rowForStage(client, 'Round 2-1').away_team_id], [1, null])

  const completedDuplicate = { ...rowForStage(client, 'Round 1-1'), id: 100, status: 'completed', winner_team_id: 2 }
  const rows = [rowForStage(client, 'Round 2-1'), rowForStage(client, 'Round 1-1'), completedDuplicate].reverse()
  const ordered = sortSeasonPlayoffGames(rows, 'single_elimination', 3)
  assert.deepEqual(ordered.map((game) => game.stage), ['Round 1-1', 'Round 2-1'])
  assert.equal(ordered[0].id, 100, 'the progressed duplicate is the canonical display row')
})
