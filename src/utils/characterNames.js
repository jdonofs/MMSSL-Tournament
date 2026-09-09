// THE ONE NAMING SYSTEM.
//
// Four vocabularies name the same 72 characters and none of them agree:
//
//   site      public.characters.name         "Koopa"  "Fire Bro"  "Light-Blue Yoshi"
//   tracker   scripts/mss_character_ids.json "Koopa Troopa"  "Fire Bro."  "Light Blue Yoshi"
//   MSS       mss_roster.CHAR_LIST           "Green Koopa Troopa"  "Red Shy Guy"
//   lowercase characterHandedness/Talents    "koopa troopa"  "king k rool"
//
// Before this file there were seven independent normalizers and five separate
// alias tables, each with different coverage, and the gaps between them were
// silent every time: a lookup that misses returns a default, not an error.
// Measured damage at the time of writing —
//
//   * getHandedness() was wrong for 7 of 72 characters. Bowser Jr. and King K.
//     Rool lost their trailing period and read as right-handed throwers; Koopa,
//     Red Koopa, Paratroopa, Green Paratroopa and Light-Blue Yoshi read as
//     right-handed batters. All seven are in the table under another spelling.
//   * live_tracker_bridge's sameCharacterName() collapsed punctuation but held
//     no aliases, so "Koopa Troopa" never matched "Koopa" — the exact failure
//     its own comment describes as dropping every putout and assist.
//   * next_calibration_game counted the archive under tracker names and looked
//     them up under site names, so six characters read as never measured and
//     were proposed for every single game.
//
// So: one alias table, one key function, and a test that walks every table in
// the repo and fails if any of them stops resolving. Add a name table, add it
// to tests/character-names.test.mjs.

// Foreign spelling -> the site's spelling. Derived from the tables themselves
// rather than typed from memory: the site drops the colour prefix on whichever
// variant it treats as the default (its "Koopa" is the green one, its "Shy Guy"
// is the red one), and MSS and the tracker always spell the colour out.
//
// Every entry is verified by tests/character-names.test.mjs: the target must be
// a real character, the key must not shadow one, and every foreign vocabulary
// must resolve completely once these are applied.
export const CHARACTER_NAME_ALIASES = Object.freeze({
  'Green Yoshi': 'Yoshi',
  'Green Koopa Troopa': 'Koopa',
  'Koopa Troopa': 'Koopa',
  'Red Koopa Troopa': 'Red Koopa',
  'Red Shy Guy': 'Shy Guy',
  'Red Koopa Paratroopa': 'Paratroopa',
  'Koopa Paratroopa': 'Paratroopa',
  'Green Koopa Paratroopa': 'Green Paratroopa',
  'Blue Magikoopa': 'Magikoopa',
  'Gray Dry Bones': 'Dry Bones',
  'Green Kritter': 'Kritter',
})

// Every Mii the game produces is named for its shirt colour and sex -- "Orange
// Mii (M)", "Red Mii (F)" -- and the site keys the whole family under one "Mii"
// because they share abilities and chemistry. Collapsing is therefore right for
// ability and chemistry lookups and WRONG for the per-Mii handedness and talent
// rows, so it is opt-in rather than baked into the key.
const MII_NAME = /^[a-z ]*\bmii\b\s*(?:\([mf]\))?$/i

function strip(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

const ALIASES_BY_KEY = new Map(
  Object.entries(CHARACTER_NAME_ALIASES).map(([from, to]) => [strip(from), to]),
)

/**
 * The comparison key for a character name, in any vocabulary.
 *
 * Two names mean the same character exactly when their keys are equal. Use this
 * for every by-name lookup and every by-name comparison; never compare the raw
 * strings, and never lowercase-only.
 */
export function characterNameKey(name, { collapseMii = false } = {}) {
  if (!name) return ''
  const text = String(name).trim()
  if (collapseMii && MII_NAME.test(text)) return 'mii'
  const key = strip(text)
  const alias = ALIASES_BY_KEY.get(key)
  return alias ? strip(alias) : key
}

/** Do these two names mean the same character, whatever spelled them? */
export function sameCharacterName(left, right, options) {
  const a = characterNameKey(left, options)
  const b = characterNameKey(right, options)
  return Boolean(a) && a === b
}

/**
 * The site's spelling of a name, given the site's own list.
 *
 * Returns the input unchanged when nothing matches, so an unknown name stays
 * visible as unmatched instead of being quietly folded into a real character.
 */
export function resolveCharacterName(name, rosterNames = [], options) {
  const key = characterNameKey(name, options)
  if (!key) return name
  for (const candidate of rosterNames) {
    if (characterNameKey(candidate, options) === key) return candidate
  }
  return name
}

/**
 * Index rows by character name so they can be looked up from any vocabulary.
 *
 * When two rows share a key the FIRST wins, because a table that lists both a
 * foreign and a site spelling of one character means the same row twice.
 */
export function indexByCharacterName(rows = [], getName = (row) => row?.name, options) {
  const index = new Map()
  for (const row of rows) {
    const key = characterNameKey(getName(row), options)
    if (key && !index.has(key)) index.set(key, row)
  }
  return index
}
