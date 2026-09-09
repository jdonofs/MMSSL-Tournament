// Translate the GAME's character ids into this app's character ids.
//
// They are different id spaces, and they look enough alike to be dangerous: of
// the 71 ids the game uses, 70 also exist in `public.characters`, and exactly
// one of those 70 names the same character. Game id 2 is Donkey Kong and app id
// 2 is Luigi. Passing a game id straight into a character column therefore does
// not fail — it writes a valid foreign key pointing at the wrong player, and
// every stat derived from it is silently attributed to someone else.
//
// So the bridge is the NAME. Every tracked id resolves through the game's own
// name table to an app character, and anything that does not resolve returns
// null rather than a guess.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHARACTER_NAME_ALIASES, characterNameKey } from '../src/utils/characterNames.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// The game's ids to the game's own names, extracted from the tracker.
const GAME_NAMES = JSON.parse(
  fs.readFileSync(path.join(HERE, 'mss_character_ids.json'), 'utf8'),
)

// THE ALIAS TABLE LIVES IN ONE PLACE: src/utils/characterNames.js. This file
// used to keep its own two-entry copy ("koopa troopa", "red koopa troopa"),
// which was right for the ids the tracker emits and short by four for the
// spellings the MSS roster and the handedness/talent tables use -- and every
// other module that needed the same answer grew its own near-miss copy in turn.
// The shared table is verified against every vocabulary by
// tests/character-names.test.mjs.
function normalize(value) {
  return characterNameKey(value)
}

const ALIAS_BY_KEY = new Map(
  Object.entries(CHARACTER_NAME_ALIASES).map(([from, to]) => [characterNameKey(from), to]),
)

/** The alias table's spelling of a name, or the name itself. */
function aliased(name) {
  // characterNameKey has already applied the alias, so a hit here is the site
  // spelling for whatever vocabulary came in.
  return ALIAS_BY_KEY.get(characterNameKey(name)) || name
}

export function trackerCharacterName(gameCharacterId) {
  const name = GAME_NAMES[String(gameCharacterId)]
  if (!name) return null
  return aliased(name)
}

/**
 * Index an app `characters` result for lookup by either spelling.
 * Accepts the rows as selected, and returns a Map keyed on the normalized name.
 */
export function indexCharactersByName(rows = []) {
  return new Map(rows.map((row) => [normalize(row.name), row]))
}

/**
 * The app character id for a character the tracker named, or null.
 *
 * Null is the point: an unresolvable character has to leave the column empty so
 * it shows up as missing data, rather than borrowing whichever character
 * happens to sit at that id in the other table.
 */
export function resolveTrackerCharacterId(gameCharacterId, charactersByName) {
  const name = trackerCharacterName(gameCharacterId)
  if (!name || !charactersByName) return null
  return charactersByName.get(normalize(name))?.id ?? null
}

/** Every tracked id this app cannot name, for a startup health check. */
export function unresolvableTrackerCharacters(charactersByName) {
  return Object.entries(GAME_NAMES)
    .filter(([id]) => resolveTrackerCharacterId(id, charactersByName) == null)
    .map(([id, name]) => ({ gameCharacterId: Number(id), name }))
}

/**
 * The roster's spelling of a name the game may spell its own way.
 *
 * `trackerCharacterName` applies this when it resolves an id, but the 60 Hz
 * capture writes the game's spelling straight onto each play, so anything
 * looking a play's character up in a roster table has to go through the same
 * two aliases or it silently finds nothing. That is not a cosmetic miss: a
 * character with no roster entry is reported as having no mapped ability, which
 * reads as "the tracker does not know" about something the roster does know.
 */
// Every Mii the game produces is named for its shirt colour and sex --
// "Orange Mii (M)", "Red Mii (F)" -- and none of those strings is in the
// roster, which keys the whole family under one entry because they all share
// the same abilities. Without this, every Mii resolved to "no mapped ability",
// which reads as the tracker not knowing something the roster does know.
const MII_NAME = /^[a-z ]*\bmii\b\s*(?:\([mf]\))?$/i

export function rosterCharacterName(name) {
  if (!name) return name
  const text = String(name)
  if (MII_NAME.test(text.trim())) return 'Mii'
  return aliased(text)
}

export { normalize as normalizeCharacterName }
