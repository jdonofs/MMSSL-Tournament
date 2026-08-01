import handednessByName from '../data/characterHandedness.json'

const DEFAULT_HANDEDNESS = { throws: 'R', bats: 'R' }

// Static per-character handedness (bats/throws) — this is fixed roster data (Mario-series
// baseball cast + Mii variants), not something derivable from gameplay data, so it's a lookup
// rather than a DB column. Keyed the same way characterTalentProfiles.json is (lowercase name).
export function getHandedness(characterName) {
  if (!characterName) return DEFAULT_HANDEDNESS
  return handednessByName[characterName.toLowerCase()] || DEFAULT_HANDEDNESS
}
