import assert from 'node:assert/strict'
import test from 'node:test'
import { recommendFielding, recommendLineup } from '../src/utils/autoTeamSetup.js'

function buildFixture() {
  const names = ['Mario', 'Luigi', 'Peach', 'Daisy', 'Yoshi', 'Birdo', 'Wario', 'Waluigi', 'Bowser']
  const players = names.map((name, index) => ({ id: index + 1, name }))
  const analysisById = Object.fromEntries(players.map((player, index) => [
    player.id,
    {
      displayRatings: {
        batting: 70 + index,
        pitching: 80 - index,
        fielding: 65 + index,
        speed: 90 - index,
      },
      rawMetrics: {
        batting: { power: 50 + (index * 2) },
        fielding: { armStrength: 60 + index, physicality: 55 + index },
      },
    },
  ]))
  return { players, analysisById }
}

test('auto lineup retains the established scoring result', () => {
  const { players, analysisById } = buildFixture()

  assert.deepEqual(
    recommendLineup(players, analysisById),
    [5, 6, 9, 8, 7, 3, 4, 2, 1],
  )
})

test('auto fielding retains the established assignment result', () => {
  const { players, analysisById } = buildFixture()

  assert.deepEqual(recommendFielding(players, analysisById), {
    pitcher: 4,
    catcher: 5,
    firstBase: 7,
    secondBase: 6,
    thirdBase: 8,
    shortStop: 9,
    leftField: 2,
    centerField: 1,
    rightField: 3,
  })
})

test('auto setup still requires exactly nine players', () => {
  const { players, analysisById } = buildFixture()

  assert.deepEqual(recommendLineup(players.slice(0, 8), analysisById), [])
  assert.deepEqual(recommendFielding(players.slice(0, 8), analysisById), {})
})
