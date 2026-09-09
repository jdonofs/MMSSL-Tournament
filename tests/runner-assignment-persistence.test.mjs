import assert from 'node:assert/strict'
import test from 'node:test'
import { runnerAssignmentsForSave } from '../src/features/scorebook/domain/plateAppearance.js'
import {
  applyManualRunnerDestination,
  buildRunnerEntriesFromAssignments,
  computePendingState,
  hydrateRunnerEntries,
  resolveScoringRunners,
  serializeRunnerEntries,
} from '../src/utils/runnerAssignment.js'

const battingPlayerId = 'player-a'

test('manual saves retain resolved destinations and pitcher responsibility', () => {
  const assignments = [
    { id: 'batter', origin: 'plate', destination: 'first', runner: { characterId: 2, playerId: battingPlayerId }, isBatter: true },
    { id: 'first', origin: 'first', destination: 'third', runner: { characterId: 3, playerId: battingPlayerId, chargedToPitcherId: 9, reachedOnError: true }, isBatter: false },
  ]
  assert.deepEqual(runnerAssignmentsForSave({ assignments, result: '1B' }), assignments)
  assert.equal(runnerAssignmentsForSave({ result: '1B', batter: assignments[0].runner }), null, 'a hit result cannot guess discretionary destinations')
})

test('strikeouts, forced walks and home runs persist every participant', () => {
  const batter = { characterId: 4, playerId: battingPlayerId }
  const runners = { first: { characterId: 1, playerId: battingPlayerId }, second: null, third: { characterId: 3, playerId: battingPlayerId } }
  const destinations = (result) => Object.fromEntries(runnerAssignmentsForSave({ result, runners, batter }).map((row) => [row.id, row.destination]))
  assert.deepEqual(destinations('K'), { batter: 'out', first: 'first', third: 'third' })
  assert.deepEqual(destinations('BB'), { batter: 'first', first: 'second', third: 'third' })
  assert.deepEqual(destinations('HR'), { batter: 'home', first: 'home', third: 'home' })
})

test('nullified third-out runs remain stranded rather than becoming scores', () => {
  const assignments = [{ id: 'third', origin: 'third', destination: 'home', runner: { characterId: 3, playerId: battingPlayerId } }]
  assert.equal(runnerAssignmentsForSave({ assignments, cancelRuns: true })[0].destination, 'third')
  assert.equal(assignments[0].destination, 'home')
})

test('the attempted base survives an out assignment round trip', () => {
  const entry = { id: 'first', origin: 'first', position: 'out', preOutPosition: 'third', runner: { characterId: 3, playerId: battingPlayerId } }
  const saved = serializeRunnerEntries([entry])
  assert.equal(saved[0].attemptedBase, 'third')
  assert.deepEqual(serializeRunnerEntries(hydrateRunnerEntries([{ ...entry, preOutPosition: null }], saved)), saved)
})

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
