import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseTrackerPositionChangeMessage,
  parseTrackerBattingMessage,
  parseTrackerLineupMessage,
  parseTrackerRunnerMessage,
  parseWorkbookStartingLineups,
  planTrackerPositionChange,
  validateTrackerAlignment,
  validateTrackerBattingOrder,
} from '../scripts/tracker_alignment.mjs'
import { fielderCoversPa, fielderIsCurrent, planFielderStintChange } from '../src/utils/fielderStints.js'

const FIREBALLS = [
  ['Yoshi', 'CF'],
  ['Green Paratroopa', 'SS'],
  ['Mario', 'P'],
  ['Hammer Bro.', '2B'],
  ['Blue Dry Bones', '1B'],
  ['Dark Bones', 'C'],
  ['Yellow Shy Guy', '3B'],
  ['Fire Bro.', 'RF'],
  ['Blooper', 'LF'],
]

const MUSCLES = [
  ['Blue Kritter', '3B'],
  ['Toadette', 'LF'],
  ['Bowser', 'C'],
  ['Wario', 'P'],
  ['Blue Pianta', 'SS'],
  ['Red Pianta', '1B'],
  ['Tiny Kong', 'RF'],
  ['Baby DK', 'CF'],
  ['Shy Guy', '2B'],
]

test('parses and validates the immediate tracker batting-order record', () => {
  const parsed = parseTrackerBattingMessage(
    '[TRACKER_BATTING] team=Fireballs|' +
    'batting=Yoshi,Green Paratroopa,Mario,Hammer Bro.,Blue Dry Bones,Dark Bones,Yellow Shy Guy,Fire Bro.,Blooper',
  )

  assert.equal(parsed.teamName, 'Fireballs')
  assert.deepEqual(parsed.batting, FIREBALLS.map(([name]) => name))
  assert.deepEqual(validateTrackerBattingOrder(parsed), {
    valid: true,
    errors: [],
    batting: FIREBALLS.map(([name]) => name),
  })
})

test('parses and validates the patched tracker live-lineup record', () => {
  const parsed = parseTrackerLineupMessage(
    '[TRACKER_LINEUP] team=Fireballs|' +
    'batting=Yoshi,Green Paratroopa,Mario,Hammer Bro.,Blue Dry Bones,Dark Bones,Yellow Shy Guy,Fire Bro.,Blooper|' +
    'fielding=P=Mario,C=Dark Bones,1B=Blue Dry Bones,2B=Hammer Bro.,3B=Yellow Shy Guy,SS=Green Paratroopa,LF=Blooper,CF=Yoshi,RF=Fire Bro.',
  )

  assert.equal(parsed.teamName, 'Fireballs')
  assert.deepEqual(parsed.batting, FIREBALLS.map(([name]) => name))
  assert.deepEqual(parsed.fielding, {
    P: 'Mario', C: 'Dark Bones', '1B': 'Blue Dry Bones', '2B': 'Hammer Bro.',
    '3B': 'Yellow Shy Guy', SS: 'Green Paratroopa', LF: 'Blooper', CF: 'Yoshi', RF: 'Fire Bro.',
  })
  assert.deepEqual(validateTrackerAlignment(parsed), { valid: true, errors: [] })
})

test('rejects incomplete or internally inconsistent tracker alignments', () => {
  const incomplete = parseTrackerLineupMessage(
    '[TRACKER_LINEUP] team=Fireballs|batting=Yoshi,Mario|fielding=P=Mario,CF=Yoshi',
  )
  const validation = validateTrackerAlignment(incomplete)
  assert.equal(validation.valid, false)
  assert.match(validation.errors.join(' '), /expected 9 batters/)
  assert.match(validation.errors.join(' '), /expected 9 fielders/)
})

test('parses authoritative tracker baserunner locations', () => {
  assert.deepEqual(parseTrackerRunnerMessage('Wario is on first.'), {
    characterName: 'Wario',
    base: 'first',
  })
  assert.deepEqual(parseTrackerRunnerMessage('Hammer Bro. is on third.'), {
    characterName: 'Hammer Bro.',
    base: 'third',
  })
  assert.equal(parseTrackerRunnerMessage('Bowser recorded a single!'), null)
})

test('parses the ordinary fielding-position messages emitted by the live tracker', () => {
  assert.deepEqual(parseTrackerPositionChangeMessage('Dark Bones was moved to C.'), {
    characterName: 'Dark Bones',
    position: 'C',
    positionNumber: 2,
  })
  assert.deepEqual(parseTrackerPositionChangeMessage('Blue Dry Bones was moved to P.'), {
    characterName: 'Blue Dry Bones',
    position: 'P',
    positionNumber: 1,
  })
  assert.equal(parseTrackerPositionChangeMessage('Blue Dry Bones vs. Blue Kritter'), null)
})

test('plans an occupied position change as a complete swap', () => {
  const openRows = [
    { id: 10, character: 'Dark Bones', character_id: 4, position: 1 },
    { id: 11, character: 'Blue Dry Bones', character_id: 9, position: 2 },
    { id: 12, character: 'Yoshi', character_id: 2, position: 8 },
  ]

  assert.deepEqual(planTrackerPositionChange(openRows, {
    characterId: 4,
    characterName: 'Dark Bones',
    positionNumber: 2,
  }), {
    alreadyApplied: false,
    affectedRows: openRows.slice(0, 2),
    assignments: [
      { characterId: 4, characterName: 'Dark Bones', positionNumber: 2 },
      { characterId: 9, characterName: 'Blue Dry Bones', positionNumber: 1 },
    ],
  })

  assert.equal(planTrackerPositionChange([
    { id: 20, character: 'Dark Bones', character_id: 4, position: 2 },
    { id: 21, character: 'Blue Dry Bones', character_id: 9, position: 1 },
  ], {
    characterId: 9,
    characterName: 'Blue Dry Bones',
    positionNumber: 1,
  }).alreadyApplied, true)
})

test('extracts both ordered lineups and defensive maps from a completed workbook', () => {
  const cells = new Map([
    ['L11', 'Mario Fireballs'],
    ['P11', 'Wario Muscles'],
  ])
  FIREBALLS.forEach(([name, position], index) => {
    cells.set(`J${20 + index}`, name)
    cells.set(`K${20 + index}`, position)
  })
  MUSCLES.forEach(([name, position], index) => {
    cells.set(`R${20 + index}`, name)
    cells.set(`Q${20 + index}`, position)
  })
  const worksheet = { getCell: (address) => ({ value: cells.get(address) ?? null }) }

  const parsed = parseWorkbookStartingLineups(worksheet)
  assert.equal(parsed.length, 2)
  assert.deepEqual(parsed.map((alignment) => alignment.batting), [
    FIREBALLS.map(([name]) => name),
    MUSCLES.map(([name]) => name),
  ])
  assert.equal(parsed[0].fielding.P, 'Mario')
  assert.equal(parsed[0].fielding.CF, 'Yoshi')
  assert.equal(parsed[1].fielding.P, 'Wario')
  assert.equal(parsed[1].fielding.C, 'Bowser')
  assert.ok(parsed.every((alignment) => validateTrackerAlignment(alignment).valid))
})

test('a mid-inning position change closes the old stint at the last play instead of deleting it', () => {
  // Game 2766: Toadette caught PA 1 in RF, then Red Pianta moved to RF, all
  // in the top of the first. Deleting her inning-1 row gave him both catches.
  const toadetteRf = { id: 't', character: 'Toadette', position: 9, inning_from: 1, inning_to: null }
  const plan = planFielderStintChange([toadetteRf], { currentInning: 1, lastPa: { pa_number: 1, inning: 1 } })
  assert.deepEqual(plan.toDelete, [])
  assert.deepEqual(plan.toClose, [toadetteRf])
  assert.deepEqual(plan.closeWith, { inning_to: 1, pa_to: 1 })
  assert.deepEqual(plan.newRowBounds, { inning_from: 1, pa_from: 2 })

  const closed = { ...toadetteRf, ...plan.closeWith }
  const redPianta = { id: 'r', character: 'Red Pianta', position: 9, ...plan.newRowBounds, inning_to: null }
  assert.ok(fielderCoversPa(closed, { inning: 1, pa_number: 1 }))
  assert.ok(!fielderCoversPa(redPianta, { inning: 1, pa_number: 1 }))
  assert.ok(fielderCoversPa(redPianta, { inning: 1, pa_number: 2 }))
  assert.ok(!fielderCoversPa(closed, { inning: 1, pa_number: 2 }))
  assert.ok(!fielderIsCurrent(closed, 1))
  assert.ok(fielderIsCurrent(redPianta, 1))
})

test('a position change at an inning boundary keeps the inning-only rows', () => {
  const early = { id: 'e', position: 9, inning_from: 1, inning_to: null }
  const thisInning = { id: 'n', position: 3, inning_from: 3, inning_to: null }
  const plan = planFielderStintChange([early, thisInning], { currentInning: 3, lastPa: { pa_number: 12, inning: 2 } })
  assert.deepEqual(plan.toClose, [early])
  assert.deepEqual(plan.toDelete, [thisInning])
  assert.deepEqual(plan.closeWith, { inning_to: 2 })
  assert.deepEqual(plan.newRowBounds, { inning_from: 3 })
  // Before the first plate appearance of the game there is nothing to keep.
  assert.deepEqual(planFielderStintChange([early], { currentInning: 1, lastPa: null }).toDelete, [early])
})

test('a second change before the next play replaces the stint that never covered one', () => {
  const unused = { id: 'u', position: 9, inning_from: 1, inning_to: null, pa_from: 2 }
  const plan = planFielderStintChange([unused], { currentInning: 1, lastPa: { pa_number: 1, inning: 1 } })
  assert.deepEqual(plan.toDelete, [unused])
  assert.deepEqual(plan.toClose, [])
})
