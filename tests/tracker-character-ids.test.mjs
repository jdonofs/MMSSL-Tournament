import assert from 'node:assert/strict'
import test from 'node:test'
import {
  indexCharactersByName,
  resolveTrackerCharacterId,
  trackerCharacterName,
  unresolvableTrackerCharacters,
} from '../scripts/tracker_character_ids.mjs'

// The roster ids here are deliberately the ones that collide: in the real
// database, app id 2 is Luigi while the GAME's id 2 is Donkey Kong.
const ROSTER = [
  { id: 2, name: 'Luigi' },
  { id: 9, name: 'Diddy Kong' },
  { id: 31, name: 'Donkey Kong' },
  { id: 44, name: 'Koopa' },
  { id: 45, name: 'Red Koopa' },
]

test('a tracked character resolves by name, never by its raw game id', () => {
  const byName = indexCharactersByName(ROSTER)
  assert.equal(trackerCharacterName(2), 'Donkey Kong')
  // The whole point: game id 2 must not come back as the roster's id 2 (Luigi).
  assert.equal(resolveTrackerCharacterId(2, byName), 31)
  assert.notEqual(resolveTrackerCharacterId(2, byName), 2)
})

test('the two names the game spells differently still resolve', () => {
  const byName = indexCharactersByName(ROSTER)
  assert.equal(trackerCharacterName(12), 'Koopa')
  assert.equal(trackerCharacterName(42), 'Red Koopa')
  assert.equal(resolveTrackerCharacterId(12, byName), 44)
  assert.equal(resolveTrackerCharacterId(42, byName), 45)
})

test('a character the roster does not have returns null rather than a stand-in', () => {
  const byName = indexCharactersByName([{ id: 2, name: 'Luigi' }])
  // Donkey Kong is not on this roster. Borrowing id 2 would attribute his
  // plays to Luigi and nothing downstream could ever notice.
  assert.equal(resolveTrackerCharacterId(2, byName), null)
  assert.equal(resolveTrackerCharacterId(9999, byName), null)
  assert.equal(resolveTrackerCharacterId(null, byName), null)
})

test('every character the game can field is reported when the roster cannot name it', () => {
  const missing = unresolvableTrackerCharacters(indexCharactersByName(ROSTER))
  assert.ok(missing.length > 0)
  assert.ok(missing.every((row) => Number.isFinite(row.gameCharacterId) && row.name))
  // Ones the roster does have must not be reported as missing.
  const names = new Set(missing.map((row) => row.name))
  assert.ok(!names.has('Donkey Kong'))
  assert.ok(!names.has('Red Koopa Troopa'))
})
