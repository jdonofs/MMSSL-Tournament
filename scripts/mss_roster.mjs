// MSS's own roster, position and stadium orderings.
//
// The index into CHAR_LIST is the value the game stores for a character, the
// index into POSITIONS is the value it stores for a fielding assignment, and
// the index into STADIUMS is what finalize() writes to STADIUM_BYTE. All three
// are copied from MSS-AutoTeam's main.py and NONE of them may be reordered.
//
// This lives in its own module because two writers now need it -- the exporter
// that turns a scheduled game into a lineup, and the calibration planner that
// writes lineups with no game behind them. A second copy of a 77-entry ordered
// list is not a duplication that announces itself when it drifts: every
// character would simply come out as a different character, in a file nobody
// reads before feeding it to the emulator.
export const CHAR_LIST = [
  'Mario', 'Luigi', 'Donkey Kong', 'Diddy Kong', 'Peach', 'Daisy',
  'Green Yoshi', 'Baby Mario', 'Baby Luigi', 'Bowser', 'Wario', 'Waluigi',
  'Green Koopa Troopa', 'Red Toad', 'Boo', 'Toadette', 'Red Shy Guy', 'Birdo',
  'Monty Mole', 'Bowser Jr.', 'Red Koopa Paratroopa', 'Blue Pianta',
  'Red Pianta', 'Yellow Pianta', 'Blue Noki', 'Red Noki', 'Green Noki',
  'Hammer Bro', 'Toadsworth', 'Blue Toad', 'Yellow Toad', 'Green Toad',
  'Purple Toad', 'Blue Magikoopa', 'Red Magikoopa', 'Green Magikoopa',
  'Yellow Magikoopa', 'King Boo', 'Petey Piranha', 'Dixie Kong', 'Goomba',
  'Paragoomba', 'Red Koopa Troopa', 'Green Koopa Paratroopa', 'Blue Shy Guy',
  'Yellow Shy Guy', 'Green Shy Guy', 'Gray Shy Guy', 'Gray Dry Bones',
  'Green Dry Bones', 'Dark Bones', 'Blue Dry Bones', 'Fire Bro',
  'Boomerang Bro', 'Wiggler', 'Blooper', 'Funky Kong', 'Tiny Kong',
  'Green Kritter', 'Blue Kritter', 'Red Kritter', 'Brown Kritter',
  'King K. Rool', 'Baby Peach', 'Baby Daisy', 'Baby DK', 'Red Yoshi',
  'Blue Yoshi', 'Yellow Yoshi', 'Light Blue Yoshi', 'Pink Yoshi',
  'Unused Yoshi 2', 'Unused Yoshi', 'Unused Toad', 'Unused Pianta',
  'Unused Kritter', 'Unused Koopa',
]

// Miis occupy roster indices after the built-in cast, in Wii Mii Plaza order.
export const FIRST_MII_INDEX = CHAR_LIST.length // 77

// Indices 71-76 are the "Unused" placeholders. mss_autoteam.py refuses to write
// anything above LAST_WRITABLE_CHAR_INDEX, so a planner must not pick them.
export const LAST_WRITABLE_CHAR_INDEX = 70

// The site's own FIELD_POSITIONS (src/components/RosterLineupWidgets.jsx) is
// this list in this order, which is why a fielding slot can be a plain index
// on both sides rather than a translated label.
export const POSITIONS = ['pitcher', 'catcher', 'firstBase', 'secondBase', 'thirdBase',
  'shortStop', 'leftField', 'centerField', 'rightField']

// MSS's stadium menu order, which is not the site's display order -- the two
// are matched by name, and all nine names are identical on both sides.
export const STADIUMS = [
  'Mario Stadium', 'Bowser Castle', 'Wario City', 'Yoshi Park',
  'Peach Ice Garden', 'DK Jungle', "Luigi's Mansion", 'Daisy Cruiser',
  'Bowser Jr. Playroom',
]

// Three of the nine stadiums exist at only one time of day, and the game's
// hazards live on the variant: Bowser Castle and Luigi's Mansion are night-only
// (Bowser Jr. Playroom is Bowser Castle's daytime cover-up), and Bowser Jr.
// Playroom is day-only. Writing the day/night bytes to the variant a park does
// not have loads the field with none of its gimmicks -- a Bowser Castle game
// written as day has no Podoboos, no statue fire, no Thwomps and no King
// Bob-omb, which is exactly what bowser_castle-20260904T011909Z recorded: zero
// hazard knockdowns (`fielder+0x23F`) in 115,795 frames, against 5 and 9 in the
// two earlier Bowser Castle sessions.
export const STADIUM_FIXED_TIME_OF_DAY = {
  'Bowser Castle': 'night',
  "Luigi's Mansion": 'night',
  'Bowser Jr. Playroom': 'day',
}

/** isNight for a park: the variant it only has, else what was requested. */
export function stadiumTimeOfDay(stadiumName, requested) {
  const fixed = STADIUM_FIXED_TIME_OF_DAY[stadiumName]
  if (fixed) return fixed === 'night'
  return Boolean(requested)
}

// Captain-eligible characters, as charList indices. finalize() stores a team's
// captain as its position in THIS list, not as a charList index.
export const CAPTAIN_CHAR_INDEXES = [0, 1, 2, 3, 4, 5, 6, 9, 10, 11, 17, 19]

// The site names the default-coloured variant of a character without its
// colour prefix ("Yoshi", "Kritter"); MSS always spells the colour out. These
// ten are the complete difference between the two vocabularies -- verified by
// diffing the site's character list against charList, which leaves nothing
// unmatched on either side except Mii, which has no charList entry at all.
export const SITE_NAME_TO_MSS_NAME = {
  Yoshi: 'Green Yoshi',
  Koopa: 'Green Koopa Troopa',
  'Shy Guy': 'Red Shy Guy',
  Paratroopa: 'Red Koopa Paratroopa',
  Magikoopa: 'Blue Magikoopa',
  'Red Koopa': 'Red Koopa Troopa',
  'Green Paratroopa': 'Green Koopa Paratroopa',
  'Dry Bones': 'Gray Dry Bones',
  Kritter: 'Green Kritter',
  'Light-Blue Yoshi': 'Light Blue Yoshi',
}

export const CHAR_INDEX_BY_MSS_NAME = Object.fromEntries(
  CHAR_LIST.map((name, index) => [name, index]),
)

/** A site character name -> its charList index, or null for a Mii. */
export function siteNameToCharIndex(siteName) {
  if (siteName === 'Mii') return null
  const mssName = SITE_NAME_TO_MSS_NAME[siteName] || siteName
  const index = CHAR_INDEX_BY_MSS_NAME[mssName]
  return index == null ? undefined : index
}
