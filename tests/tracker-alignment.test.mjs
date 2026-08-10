import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseTrackerBattingMessage,
  parseTrackerLineupMessage,
  parseTrackerRunnerMessage,
  parseWorkbookStartingLineups,
  validateTrackerAlignment,
  validateTrackerBattingOrder,
} from '../scripts/tracker_alignment.mjs'

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
