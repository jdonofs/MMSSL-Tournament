// Prop research: the historical context shown beside a hit / home-run /
// strikeout market.
//
// The point of most of these tests is what the card refuses to do — count a
// game the target is not recorded in as a zero, mix a live game into a
// historical average, or let one competition's rows reach another.

import assert from 'node:assert/strict'
import test from 'node:test'

import { buildPropResearch, isResearchableProp } from '../src/utils/propResearch.js'

const AWAY = { id: 'p1', name: 'Aidan' }
const HOME = { id: 'p2', name: 'Donovan' }
const PLAYERS = { p1: AWAY, p2: HOME }
const CHARACTERS = {
  11: { id: 11, name: 'Mario' },
  12: { id: 12, name: 'Luigi' },
  22: { id: 22, name: 'Daisy' },
}
const MARIO = 'Mario (Aidan)'
const DAISY = 'Daisy (Donovan)'

function game(id, status = 'complete', overrides = {}) {
  return {
    id,
    status,
    team_a_player_id: AWAY.id,
    team_b_player_id: HOME.id,
    game_code: `G${id}`,
    created_at: `2026-07-${String(10 + id).padStart(2, '0')}T12:00:00.000Z`,
    ...overrides,
  }
}

function pa(gameId, result, { characterId = 11, playerId = 'p1', isError = false } = {}) {
  return { game_id: gameId, character_id: characterId, player_id: playerId, result, is_error: isError }
}

function stint(gameId, strikeouts, { characterId = 22, playerId = 'p2' } = {}) {
  return { game_id: gameId, character_id: characterId, player_id: playerId, strikeouts }
}

const GAMES = [game(1), game(2), game(3), game(4, 'active')]

const labelForPlayer = (playerId) => PLAYERS[playerId]?.name || null

function research(overrides = {}) {
  return buildPropResearch({
    betType: 'hit_prop',
    targetEntity: MARIO,
    games: GAMES,
    plateAppearances: [],
    pitchingStints: [],
    charactersById: CHARACTERS,
    playersById: PLAYERS,
    currentGameId: 4,
    competitionLabel: 'Tournament 5',
    labelForPlayer,
    ...overrides,
  })
}

test('only games with a recorded appearance enter the denominator', () => {
  // Mario batted in games 1 and 3 only. Game 2 has no row for him.
  const result = research({
    plateAppearances: [
      pa(1, '1B'), pa(1, 'K'),
      pa(2, '2B', { characterId: 12 }),
      pa(3, 'HR'), pa(3, '1B'),
    ],
  })

  assert.equal(result.eligibleGames, 2)
  assert.equal(result.completedGamesInCompetition, 3)
  assert.equal(result.gamesWithoutRecordedAppearance, 1)
  assert.equal(result.total, 3, '1 hit in game 1, 2 in game 3')
  assert.equal(result.average, 1.5)
  assert.match(result.denominatorLabel, /n = 2/)
  assert.ok(result.coverage.some((note) => /left out of the average/.test(note)))
})

test('a game the target played with no hits is a real zero and stays in the sample', () => {
  const result = research({
    plateAppearances: [pa(1, '1B'), pa(2, 'K'), pa(2, 'GO'), pa(3, '2B')],
  })

  assert.equal(result.eligibleGames, 3)
  assert.equal(result.gamesWithoutRecordedAppearance, 0)
  assert.equal(result.total, 2)
  assert.equal(result.average, 2 / 3)
  assert.deepEqual(result.recent.map((entry) => entry.value), [1, 0, 1], 'newest first')
})

test('the live game is reported separately and never enters the average', () => {
  const result = research({
    plateAppearances: [pa(1, '1B'), pa(3, '1B'), pa(4, 'HR'), pa(4, '2B')],
  })

  assert.equal(result.eligibleGames, 2)
  assert.equal(result.average, 1)
  assert.equal(result.live.value, 2)
  assert.equal(result.live.appeared, true)
  assert.match(result.live.note, /Not included in the average/)
  assert.ok(!result.games.some((entry) => entry.gameId === 4))
})

test('an error that wipes out a hit is not counted as one', () => {
  const result = research({
    plateAppearances: [pa(1, '1B'), pa(1, '2B', { isError: true }), pa(2, '1B')],
  })

  assert.equal(result.total, 2)
  assert.equal(result.eligibleGames, 2)
})

test('home-run research counts only credited home runs', () => {
  const result = research({
    betType: 'hr_prop',
    plateAppearances: [pa(1, 'HR'), pa(1, '1B'), pa(2, 'IPHR'), pa(3, '2B')],
  })

  assert.equal(result.statLabel, 'Home runs')
  assert.equal(result.total, 2)
  assert.equal(result.eligibleGames, 3)
  assert.equal(result.average, 2 / 3)
})

test('strikeout research uses pitching stints and identifies the target as a pitcher', () => {
  const result = research({
    betType: 'k_prop',
    targetEntity: DAISY,
    pitchingStints: [stint(1, 3), stint(1, 1), stint(3, 5)],
  })

  assert.equal(result.role, 'pitcher')
  assert.equal(result.eligibleGames, 2, 'two games with a recorded appearance')
  assert.equal(result.total, 9, 'both stints in game 1 count')
  assert.equal(result.average, 4.5)
  assert.equal(result.entity.characterName, 'Daisy')
  assert.equal(result.entity.playerName, 'Donovan')
})

test('a target with no recorded appearance at all reports no rate rather than zero', () => {
  const result = research({ plateAppearances: [pa(1, '1B', { characterId: 12 })] })

  assert.equal(result.eligibleGames, 0)
  assert.equal(result.average, null)
  assert.equal(result.total, 0)
  assert.equal(result.denominatorLabel, 'no eligible completed games')
  assert.ok(result.coverage.some((note) => /no historical rate to report/.test(note)))
})

test('an unfinished game never contributes to the historical sample', () => {
  const result = research({
    currentGameId: null,
    plateAppearances: [pa(1, '1B'), pa(4, 'HR'), pa(4, 'HR')],
  })

  assert.equal(result.eligibleGames, 1, 'game 4 is still active')
  assert.equal(result.total, 1)
})

test('opponent labels come from the game, from the target’s own side', () => {
  const result = research({ plateAppearances: [pa(1, '1B'), pa(2, '1B')] })

  // Mario plays for the away team, so every opponent reads as an away game.
  assert.deepEqual(result.games.map((entry) => entry.opponent), ['@ Donovan', '@ Donovan'])
})

test('the recent list is capped and links back to real games', () => {
  const manyGames = Array.from({ length: 8 }, (_, index) => game(index + 1))
  const result = buildPropResearch({
    betType: 'hit_prop',
    targetEntity: MARIO,
    games: manyGames,
    plateAppearances: manyGames.map((entry) => pa(entry.id, '1B')),
    pitchingStints: [],
    charactersById: CHARACTERS,
    playersById: PLAYERS,
    currentGameId: null,
    recentLimit: 5,
    labelForPlayer,
  })

  assert.equal(result.eligibleGames, 8)
  assert.equal(result.recent.length, 5)
  assert.deepEqual(result.recent.map((entry) => entry.gameId), [8, 7, 6, 5, 4], 'newest first')
  assert.ok(result.recent.every((entry) => entry.sourceGameId != null))
})

test('a season row set and a tournament row set with the same game ids do not mix', () => {
  const shared = { games: GAMES, charactersById: CHARACTERS, playersById: PLAYERS, currentGameId: null, labelForPlayer }

  const tournament = buildPropResearch({
    ...shared, betType: 'hit_prop', targetEntity: MARIO, pitchingStints: [],
    plateAppearances: [pa(1, '1B'), pa(2, '1B'), pa(3, '1B')],
  })
  const season = buildPropResearch({
    ...shared, betType: 'hit_prop', targetEntity: MARIO, pitchingStints: [],
    plateAppearances: [pa(1, 'K')],
  })

  assert.equal(tournament.total, 3)
  assert.equal(tournament.eligibleGames, 3)
  assert.equal(season.total, 0)
  assert.equal(season.eligibleGames, 1, 'only the one game the season rows cover')
})

test('a season schedule id survives into the game link', () => {
  const result = buildPropResearch({
    betType: 'hit_prop',
    targetEntity: MARIO,
    games: [{ ...game(1), id: 'season-1', source_game_id: 1 }],
    plateAppearances: [{ ...pa(1, '1B'), game_id: 'season-1' }],
    pitchingStints: [],
    charactersById: CHARACTERS,
    playersById: PLAYERS,
    currentGameId: null,
    labelForPlayer,
  })

  assert.equal(result.games[0].gameId, 'season-1')
  assert.equal(result.games[0].sourceGameId, 1)
})

test('an unsupported market has no research card', () => {
  assert.equal(isResearchableProp('hit_prop'), true)
  assert.equal(isResearchableProp('moneyline'), false)
  assert.equal(buildPropResearch({ betType: 'moneyline', targetEntity: MARIO }), null)
  assert.equal(buildPropResearch({ betType: 'hit_prop', targetEntity: null }), null)
})

test('an empty dataset produces an empty card, not a crash', () => {
  const result = buildPropResearch({ betType: 'hit_prop', targetEntity: MARIO })

  assert.equal(result.eligibleGames, 0)
  assert.equal(result.completedGamesInCompetition, 0)
  assert.deepEqual(result.games, [])
  assert.equal(result.live, null)
})
