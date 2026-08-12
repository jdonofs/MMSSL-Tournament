import assert from 'node:assert/strict'
import test from 'node:test'
import {
  applyManualRunnerDestination,
  buildRunnerEntriesFromAssignments,
  computePendingState,
  hydrateRunnerEntries,
  resolveScoringRunners,
  serializeRunnerEntries,
} from '../src/utils/runnerAssignment.js'

const battingPlayerId = 'player-a'

test('hydrates and serializes saved runner destinations', () => {
  const defaults = [
    { id: 'first', origin: 'first', position: 'second', runner: { characterId: 11, playerId: battingPlayerId } },
    { id: 'batter', origin: 'home', position: 'first', runner: { characterId: 12, playerId: battingPlayerId } },
  ]
  const stored = [
    { id: 'first', origin: 'first', destination: 'third', runner: { characterId: 11, playerId: battingPlayerId } },
    { id: 'batter', origin: 'home', destination: 'first', runner: { characterId: 12, playerId: battingPlayerId }, isBatter: true },
  ]

  const hydrated = hydrateRunnerEntries(defaults, stored)
  assert.deepEqual(hydrated.map((entry) => entry.position), ['third', 'first'])
  assert.deepEqual(serializeRunnerEntries(hydrated), [
    { id: 'first', origin: 'first', destination: 'third', runner: { characterId: 11, playerId: battingPlayerId }, isBatter: false },
    { id: 'batter', origin: 'home', destination: 'first', runner: { characterId: 12, playerId: battingPlayerId }, isBatter: true },
  ])
})

test('credits a scoring baserunner instead of the batter', () => {
  const batter = { characterId: 40, playerId: battingPlayerId }
  const petey = { characterId: 24, playerId: battingPlayerId }
  const assignments = [
    { id: 'third', runner: petey, origin: 'third', destination: 'home' },
    { id: 'batter', runner: batter, origin: 'home', destination: 'first', isBatter: true },
  ]

  assert.deepEqual(resolveScoringRunners(['third'], assignments, {}, batter), [petey])
})

test('persists a lead runner holding third without restoring the default score', () => {
  const batter = { characterId: 40, playerId: battingPlayerId }
  const bowserJr = { characterId: 8, playerId: battingPlayerId }
  const petey = { characterId: 24, playerId: battingPlayerId }
  const runners = { first: null, second: bowserJr, third: petey }
  const defaults = buildRunnerEntriesFromAssignments(computePendingState('1B', runners, batter), runners)

  const corrected = applyManualRunnerDestination(defaults, 'third', 'third')
  assert.deepEqual(
    Object.fromEntries(corrected.map((entry) => [entry.id, entry.position])),
    { batter: 'first', second: 'second', third: 'third' },
  )

  const reloaded = hydrateRunnerEntries(defaults, serializeRunnerEntries(corrected))
  assert.deepEqual(
    Object.fromEntries(reloaded.map((entry) => [entry.id, entry.position])),
    { batter: 'first', second: 'second', third: 'third' },
  )
})
