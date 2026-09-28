import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(HERE, '..', 'src', 'data', file), 'utf8'))
const profiles = readJson('characterTalentProfiles.json')
const catches = readJson('characterCatchMechanics.json')

test('corrected catch mechanics cover every character profile', () => {
  assert.equal(Object.keys(catches).length, 101)
  assert.deepEqual(Object.keys(catches).sort(), Object.keys(profiles).sort())
})

test('corrected catch labels preserve the revised workbook semantics', () => {
  assert.deepEqual(catches.mario, {
    regular: 1.888,
    facingAway: 0.944,
    saferCatch: 0.826,
    height: 3.009,
    reachUpThreshold: 0.944,
    unknownHeightLike: 3.894,
    dive: 2.596,
    lineDriveDiveHeight: 2.5,
    jump: 0.944,
    unknownRegularLike: 2.124,
  })

  // Column K is what the original sheet called jumpWidth; the revised import
  // carries it under a name that does not claim to know what it is.
  assert.equal(profiles.mario.catch.jumpWidth, catches.mario.unknownRegularLike)
  assert.notEqual(catches.mario.jump, catches.mario.unknownRegularLike)
})

// Column J arrived labelled `jump`. It cannot be a jump reach, and this is the
// evidence, asserted rather than left in a comment so the label cannot quietly
// be promoted back into the rating.
test('neither column J nor column K is established as the jump reach', () => {
  const rows = Object.values(catches)
  const jEqualsFacingAway = rows.filter((row) => row.jump === row.facingAway).length
  const jBelowStanding = rows.filter((row) => row.jump < row.regular).length
  const kAboveStanding = rows.filter((row) => row.unknownRegularLike > row.regular).length

  // J repeats the facing-away radius almost everywhere and is half the
  // standing radius. A jumping catch does not reach less far than a standing
  // one, so J is not it.
  assert.ok(jEqualsFacingAway >= 90, `J repeats facingAway in ${jEqualsFacingAway}/101`)
  assert.ok(jBelowStanding >= 90, `J is below regular in ${jBelowStanding}/101`)
  // K behaves the way a jump reach should, which is why the rating still uses
  // it -- but "behaves plausibly" is not proof, so it keeps an honest name.
  assert.ok(kAboveStanding >= 70, `K is above regular in ${kAboveStanding}/101`)
})

test('all corrected catch fields are finite and non-negative', () => {
  for (const [name, profile] of Object.entries(catches)) {
    assert.equal(Object.keys(profile).length, 10, name)
    for (const [field, value] of Object.entries(profile)) {
      assert.ok(Number.isFinite(value) && value >= 0, `${name}.${field}`)
    }
  }
})
