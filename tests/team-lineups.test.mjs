import assert from 'node:assert/strict'
import test from 'node:test'
import { buildActivePitcherByGamePlayer, gamePitcherKey } from '../src/utils/teamLineupProjection.js'

test('betting resolves the active season pitcher from game fielders', () => {
  const games = [{ id: 2421, team_a_player_id: 'aidan', team_b_player_id: 'nick' }]
  const result = buildActivePitcherByGamePlayer({
    games,
    isSeasonMode: true,
    seasonTeams: [
      { id: 351, player_id: 'aidan' },
      { id: 356, player_id: 'nick' },
    ],
    characters: [
      { id: 1, name: 'Mario' },
      { id: 2, name: 'Wario' },
      { id: 3, name: 'Bowser' },
    ],
    gameFielders: [
      { id: 1, game_id: 2421, team_id: 351, character: 'Mario', position: 1, inning_from: 1, inning_to: null },
      { id: 2, game_id: 2421, team_id: 356, character: 'Wario', position: 1, inning_from: 1, inning_to: 2 },
      { id: 3, game_id: 2421, team_id: 356, character: 'Bowser', position: 1, inning_from: 3, inning_to: null },
    ],
  })

  assert.deepEqual(result, {
    [gamePitcherKey(2421, 'aidan')]: 1,
    [gamePitcherKey(2421, 'nick')]: 3,
  })
})

test('pitcher keys stay game-specific for repeated tournament matchups', () => {
  const games = [
    { id: 10, team_a_player_id: 'a', team_b_player_id: 'b' },
    { id: 11, team_a_player_id: 'a', team_b_player_id: 'b' },
  ]
  const result = buildActivePitcherByGamePlayer({
    games,
    characters: [{ id: 7, name: 'Yoshi' }, { id: 8, name: 'Mario' }],
    gameFielders: [
      { game_id: 10, team_id: 'a', character: 'Yoshi', position: 1, inning_from: 1, inning_to: null },
      { game_id: 11, team_id: 'a', character: 'Mario', position: 1, inning_from: 1, inning_to: null },
    ],
  })

  assert.equal(result[gamePitcherKey(10, 'a')], 7)
  assert.equal(result[gamePitcherKey(11, 'a')], 8)
  assert.equal(Object.keys(result).length, 2)
})
