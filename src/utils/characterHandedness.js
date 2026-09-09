import handednessByName from '../data/characterHandedness.json'
import { characterNameKey, indexByCharacterName } from './characterNames.js'

const DEFAULT_HANDEDNESS = { throws: 'R', bats: 'R' }

// Static per-character handedness (bats/throws) — this is fixed roster data (Mario-series
// baseball cast + Mii variants), not something derivable from gameplay data, so it's a lookup
// rather than a DB column.
//
// THE JSON IS KEYED IN THE GAME'S VOCABULARY, not the site's: "koopa troopa",
// "green koopa paratroopa", "king k rool", "light blue yoshi". This used to do
// `name.toLowerCase()` and nothing else, which missed seven of the seventy-two
// characters and returned the R/R default for them rather than saying it did
// not know. Bowser Jr. and King K. Rool lost on the trailing period alone.
// Koopa, Red Koopa, Paratroopa, Green Paratroopa and Light-Blue Yoshi are all
// left-handed batters that the app was showing as right-handed, everywhere
// handedness is used — Scorebook, platoon splits, statsCalculator.
const HANDEDNESS_BY_KEY = indexByCharacterName(
  Object.entries(handednessByName).map(([name, value]) => ({ name, value })),
)

export function getHandedness(characterName) {
  if (!characterName) return DEFAULT_HANDEDNESS
  return HANDEDNESS_BY_KEY.get(characterNameKey(characterName))?.value || DEFAULT_HANDEDNESS
}
