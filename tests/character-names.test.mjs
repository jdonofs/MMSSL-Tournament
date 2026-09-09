// THE SYSTEM-WIDE NAME CHECK.
//
// Four vocabularies name the same 72 characters and none of them agree. Every
// table below is keyed in one of them, and every gap between two of them is
// silent: a by-name lookup that misses returns a default, never an error. That
// is how getHandedness came to report seven characters as right-handed, how the
// bridge dropped Koopa's putouts, and how the calibration planner proposed the
// same six characters for every game it ever emitted.
//
// So this walks EVERY character name table in the repo and fails if any one of
// them stops resolving through src/utils/characterNames.js. Add a name table,
// add it here.
//
// The canonical roster is a fixture rather than a live query, because a test
// that needs the network is a test that gets skipped. The live table is guarded
// separately and at the place that already reads it: next_calibration_game.mjs
// prints every capture name it could not resolve to a site character, so a new
// character or a renamed one surfaces there on the next run.

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CHARACTER_NAME_ALIASES,
  characterNameKey,
  indexByCharacterName,
  resolveCharacterName,
  sameCharacterName,
} from '../src/utils/characterNames.js'
import { CHARACTER_VARIANTS, CHEMISTRY, chemistryNamesMatch } from '../src/data/chemistry.js'
import {
  CHARACTER_BASERUNNING_ABILITY,
  CHARACTER_FIELDING_ABILITY,
  CHARACTER_STAR_PITCH,
  CHARACTER_STAR_SWING,
} from '../src/data/characterAbilities.js'
import { CHAR_LIST, SITE_NAME_TO_MSS_NAME, siteNameToCharIndex } from '../scripts/mss_roster.mjs'
import { rosterCharacterName, trackerCharacterName } from '../scripts/tracker_character_ids.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const repo = (...parts) => path.join(HERE, '..', ...parts)
const readJson = (...parts) => JSON.parse(fs.readFileSync(repo(...parts), 'utf8'))

// public.characters.name, as of 2026-09-03. Sorted so a diff reads cleanly.
const CANONICAL = [
  'Baby Daisy', 'Baby DK', 'Baby Luigi', 'Baby Mario', 'Baby Peach', 'Birdo',
  'Blooper', 'Blue Dry Bones', 'Blue Kritter', 'Blue Noki', 'Blue Pianta',
  'Blue Shy Guy', 'Blue Toad', 'Blue Yoshi', 'Boo', 'Boomerang Bro', 'Bowser',
  'Bowser Jr.', 'Brown Kritter', 'Daisy', 'Dark Bones', 'Diddy Kong',
  'Dixie Kong', 'Donkey Kong', 'Dry Bones', 'Fire Bro', 'Funky Kong',
  'Goomba', 'Gray Shy Guy', 'Green Dry Bones', 'Green Magikoopa',
  'Green Noki', 'Green Paratroopa', 'Green Shy Guy', 'Green Toad',
  'Hammer Bro', 'King Boo', 'King K. Rool', 'Koopa', 'Kritter',
  'Light-Blue Yoshi', 'Luigi', 'Magikoopa', 'Mario', 'Mii', 'Monty Mole',
  'Paragoomba', 'Paratroopa', 'Peach', 'Petey Piranha', 'Pink Yoshi',
  'Purple Toad', 'Red Koopa', 'Red Kritter', 'Red Magikoopa', 'Red Noki',
  'Red Pianta', 'Red Toad', 'Red Yoshi', 'Shy Guy', 'Tiny Kong', 'Toadette',
  'Toadsworth', 'Waluigi', 'Wario', 'Wiggler', 'Yellow Magikoopa',
  'Yellow Pianta', 'Yellow Shy Guy', 'Yellow Toad', 'Yellow Yoshi', 'Yoshi',
]

// Characters with no entry, and why that is correct rather than a gap.
const KNOWN_ABSENT = {
  // A Mii cannot be written into the formation struct and has no charList slot;
  // the game names each one for its shirt colour, so the per-Mii tables carry
  // "Red Mii (M)" and friends instead of a single "Mii" row.
  'mss_roster CHAR_LIST': ['Mii'],
  'mss_character_ids.json': ['Mii'],
  'characterHandedness.json': ['Mii'],
  'characterTalentProfiles.json': ['Mii'],
  // Chemistry is a property of WHICH Mii, not of the family: the table carries
  // "Dark Blue Mii", "Red Mii" and the rest because other characters have
  // chemistry with a specific one. Which Mii a player's pick means is
  // scripts/mss_mii_map.json's job, and characterAbilities.CHEMISTRY_NAME_MAP
  // supplies the stand-in when nothing narrower is known.
  'chemistry (CHEMISTRY + CHARACTER_VARIANTS)': ['Mii'],
}

function missingFrom(label, names) {
  const index = indexByCharacterName(names.map((name) => ({ name })))
  const absent = new Set((KNOWN_ABSENT[label] || []).map((n) => characterNameKey(n)))
  return CANONICAL.filter((c) => !index.has(characterNameKey(c)) && !absent.has(characterNameKey(c)))
}

test('the alias table is well formed', () => {
  const canonicalKeys = new Set(CANONICAL.map((n) => characterNameKey(n)))
  for (const [from, to] of Object.entries(CHARACTER_NAME_ALIASES)) {
    // The target has to be a real character, or the alias sends every lookup
    // that uses it into a name nothing else knows.
    assert.ok(canonicalKeys.has(characterNameKey(to)),
      `alias ${from} -> ${to}: the target is not a character`)
    // An alias whose own key is a real character would shadow that character.
    // "Red Shy Guy" -> "Shy Guy" is only safe because the site has no separate
    // Red Shy Guy; if one is ever added, this fails instead of merging them.
    const rawKey = String(from).toLowerCase().replace(/[^a-z0-9]/g, '')
    assert.ok(!canonicalKeys.has(rawKey) || characterNameKey(to) === rawKey,
      `alias ${from} shadows a real character`)
  }
})

test('no two characters collapse to the same key', () => {
  const byKey = new Map()
  for (const name of CANONICAL) {
    const key = characterNameKey(name)
    assert.ok(!byKey.has(key), `${name} and ${byKey.get(key)} share the key "${key}"`)
    byKey.set(key, name)
  }
})

test('every character name table in the repo resolves for every character', () => {
  const sprites = fs.readFileSync(repo('src/utils/characterSprites.js'), 'utf8')
  const spriteNames = [...sprites.matchAll(/^\s{2}'?([A-Za-z0-9 .'\-()]+?)'?:\s*\[/gm)].map((m) => m[1])

  const tables = {
    'mss_roster CHAR_LIST': CHAR_LIST.concat(Object.keys(SITE_NAME_TO_MSS_NAME)),
    'mss_character_ids.json': Object.values(readJson('scripts/mss_character_ids.json')),
    'chemistry (CHEMISTRY + CHARACTER_VARIANTS)':
      Object.keys(CHEMISTRY).concat(Object.keys(CHARACTER_VARIANTS)),
    'abilities CHARACTER_FIELDING_ABILITY': Object.keys(CHARACTER_FIELDING_ABILITY),
    'abilities CHARACTER_BASERUNNING_ABILITY': Object.keys(CHARACTER_BASERUNNING_ABILITY),
    'abilities CHARACTER_STAR_PITCH': Object.keys(CHARACTER_STAR_PITCH),
    'abilities CHARACTER_STAR_SWING': Object.keys(CHARACTER_STAR_SWING),
    'characterSprites spriteCells': spriteNames,
    'characterHandedness.json': Object.keys(readJson('src/data/characterHandedness.json')),
    'characterTalentProfiles.json': Object.keys(readJson('src/data/characterTalentProfiles.json')),
    'characterImages.json': readJson('src/data/characterImages.json').map((r) => r.name),
  }

  const failures = []
  for (const [label, names] of Object.entries(tables)) {
    const missing = missingFrom(label, names)
    if (missing.length) failures.push(`${label}: ${missing.join(', ')}`)
  }
  assert.deepEqual(failures, [], `tables that cannot name every character:\n  ${failures.join('\n  ')}`)
})

test('every name each table holds resolves back to a real character', () => {
  // The reverse direction. A table entry that names nothing is either a typo or
  // a character the roster lost, and both are worth a failure -- with the
  // deliberate exceptions each table documents.
  const canonicalKeys = new Set(CANONICAL.map((n) => characterNameKey(n)))
  const isMii = (n) => /\bmii\b/i.test(n)
  const isUnused = (n) => /^unused/i.test(n)

  const tables = {
    'mss_roster CHAR_LIST': CHAR_LIST,
    'mss_character_ids.json': Object.values(readJson('scripts/mss_character_ids.json')),
    'characterHandedness.json': Object.keys(readJson('src/data/characterHandedness.json')),
    'characterTalentProfiles.json': Object.keys(readJson('src/data/characterTalentProfiles.json')),
  }
  const failures = []
  for (const [label, names] of Object.entries(tables)) {
    const orphans = names.filter((n) => n && !isMii(n) && !isUnused(n)
      && !canonicalKeys.has(characterNameKey(n)))
    if (orphans.length) failures.push(`${label}: ${orphans.join(', ')}`)
  }
  assert.deepEqual(failures, [])
})

test('the handedness table answers for every character it has a row for', () => {
  // getHandedness's own lookup, which is why this is the shape it is: seven
  // characters used to fall through to the R/R default while the table held
  // their real values under another spelling.
  const rows = readJson('src/data/characterHandedness.json')
  const index = indexByCharacterName(
    Object.entries(rows).map(([name, value]) => ({ name, value })),
  )
  const known = {
    'Bowser Jr.': { throws: 'L', bats: 'R' },
    'King K. Rool': { throws: 'L', bats: 'R' },
    Koopa: { throws: 'R', bats: 'L' },
    'Red Koopa': { throws: 'R', bats: 'L' },
    Paratroopa: { throws: 'R', bats: 'L' },
    'Green Paratroopa': { throws: 'R', bats: 'L' },
    'Light-Blue Yoshi': { throws: 'R', bats: 'L' },
  }
  for (const [name, expected] of Object.entries(known)) {
    assert.deepEqual(index.get(characterNameKey(name))?.value, expected,
      `${name} must not fall through to the default`)
  }
  // Per-Mii rows must stay distinct: collapsing the family is right for
  // abilities and chemistry and wrong here.
  assert.notEqual(characterNameKey('Red Mii (M)'), characterNameKey('Red Mii (F)'))
})

test('a tracker name and a site name are recognised as one character', () => {
  const pairs = [
    ['Koopa Troopa', 'Koopa'],
    ['Red Koopa Troopa', 'Red Koopa'],
    ['Green Koopa Paratroopa', 'Green Paratroopa'],
    ['Koopa Paratroopa', 'Paratroopa'],
    ['Fire Bro.', 'Fire Bro'],
    ['Hammer Bro.', 'Hammer Bro'],
    ['Boomerang Bro.', 'Boomerang Bro'],
    ['Light Blue Yoshi', 'Light-Blue Yoshi'],
    ['Green Yoshi', 'Yoshi'],
    ['Red Shy Guy', 'Shy Guy'],
    ['Blue Magikoopa', 'Magikoopa'],
    ['Gray Dry Bones', 'Dry Bones'],
    ['Green Kritter', 'Kritter'],
  ]
  for (const [tracker, site] of pairs) {
    assert.ok(sameCharacterName(tracker, site), `${tracker} should be ${site}`)
    assert.equal(resolveCharacterName(tracker, CANONICAL), site)
  }
  // And characters that merely look alike stay apart.
  for (const [a, b] of [['Red Yoshi', 'Yoshi'], ['Red Toad', 'Toad'],
    ['Green Paratroopa', 'Paratroopa'], ['Red Koopa', 'Koopa'],
    ['Green Dry Bones', 'Dry Bones'], ['Blue Kritter', 'Kritter']]) {
    assert.ok(!sameCharacterName(a, b), `${a} and ${b} are different characters`)
  }
})

test('every tracked game id names a character the site knows', () => {
  const gameIds = readJson('scripts/mss_character_ids.json')
  const canonicalKeys = new Set(CANONICAL.map((n) => characterNameKey(n)))
  const unresolved = Object.keys(gameIds)
    .map((id) => [id, trackerCharacterName(id)])
    .filter(([, name]) => !name || !canonicalKeys.has(characterNameKey(name)))
  assert.deepEqual(unresolved, [])
})

test('every character can be written into the formation struct', () => {
  // siteNameToCharIndex is what puts a lineup in the game's memory. Two names
  // landing on one index would field the same character twice.
  const byIndex = new Map()
  for (const name of CANONICAL) {
    if (name === 'Mii') continue
    const index = siteNameToCharIndex(name)
    assert.ok(index != null, `${name} has no charList index`)
    assert.ok(!byIndex.has(index),
      `${name} and ${byIndex.get(index)} both map to charList[${index}]`)
    byIndex.set(index, name)
  }
})

test('chemistry matches across vocabularies without merging variants', () => {
  assert.ok(chemistryNamesMatch('Koopa Troopa', 'Koopa'))
  assert.ok(chemistryNamesMatch('Fire Bro.', 'Fire Bro'))
  // A variant still matches its base, which is what CHARACTER_VARIANTS is for.
  assert.ok(chemistryNamesMatch('Red Yoshi', 'Yoshi'))
  // Two variants of one base DO match, and that is deliberate: chemistry is a
  // property of the family, so every Kritter has chemistry with every other.
  assert.ok(chemistryNamesMatch('Red Kritter', 'Blue Kritter'))
  // Unrelated characters do not.
  assert.ok(!chemistryNamesMatch('Mario', 'Luigi'))
  assert.ok(!chemistryNamesMatch('Red Kritter', 'Red Yoshi'))
})

test('rosterCharacterName gives the site spelling for any vocabulary', () => {
  assert.equal(rosterCharacterName('Koopa Troopa'), 'Koopa')
  assert.equal(rosterCharacterName('Red Koopa Troopa'), 'Red Koopa')
  assert.equal(rosterCharacterName('Green Koopa Paratroopa'), 'Green Paratroopa')
  assert.equal(rosterCharacterName('Orange Mii (M)'), 'Mii')
  assert.equal(rosterCharacterName('Mario'), 'Mario')
})
