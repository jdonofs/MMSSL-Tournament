// Resolve runner destinations from the 60 Hz runner slots carried by a joined
// play. `bases_ran` is the runner's absolute destination (1/2/3/home), not the
// number of bases advanced. The stock text feed does not announce every
// discretionary advance, so this is the only complete same-play source.

import { characterNameKey } from '../src/utils/characterNames.js'

const BASE_BY_NUMBER = Object.freeze({ 1: 'first', 2: 'second', 3: 'third' })
const SLOT_BY_ORIGIN = Object.freeze({
  plate: 'BAT',
  home: 'BAT',
  first: 'R1',
  second: 'R2',
  third: 'R3',
})
const BATTER_OUT_RESULTS = new Set(['K', 'GO', 'FO', 'LO', 'DP', 'TP', 'SF', 'SH'])

function normalizedName(value) {
  return characterNameKey(value)
}

function sameRunner(entry, telemetry) {
  if (!entry || !telemetry) return false
  // characterId belongs to the database. Only an explicitly tagged tracker
  // ID may be compared with the collector's game ID space.
  if (entry.trackerCharacterId != null && telemetry.character_id != null) {
    return Number(entry.trackerCharacterId) === Number(telemetry.character_id)
  }
  return Boolean(entry.characterName && telemetry.character
    && normalizedName(entry.characterName) === normalizedName(telemetry.character))
}

function telemetryForEntry(play, entry) {
  const runners = play?.runners || {}
  const direct = runners[SLOT_BY_ORIGIN[entry.origin]]
  if (direct?.batting_index !== -1 && sameRunner(entry, direct)) return direct

  // Old captures can leave an empty runner slot carrying a stale character.
  // A real participant has a non-negative batting index, so prefer those when
  // recovering by identity rather than accepting the stale direct slot.
  return Object.values(runners).find((runner) => runner?.batting_index >= 0
    && sameRunner(entry, runner)) || null
}

// The base a retired runner was going for: the throw that recorded his out
// names it. The deriver stamps every throw with the bag its receiver stood on
// and the runner nearest that bag on arrival. Without this a runner thrown out
// taking the extra base could not be told from one retired short of the base
// the hit guaranteed him, so tracker-scored games recorded no thrown-out
// extra-base attempt at all -- only the manual Scorebook set it.
function attemptedBaseFromThrows(play, entry) {
  const retiring = (play?.throws || []).find((row) => Number(row?.outs_recorded) > 0
    && row.target_base && row.runner_at_arrival
    && sameRunner(entry, row.runner_at_arrival))
  return retiring?.target_base || null
}

function identityKey({ characterId = null, characterName = null } = {}) {
  if (characterName) return `name:${normalizedName(characterName)}`
  return characterId != null ? `id:${Number(characterId)}` : null
}

/**
 * Return destinations for every supplied runner, or null if even one runner
 * cannot be resolved without guessing.
 *
 * Each entry is { id, origin, isBatter, characterName?, characterId? }.
 */
export function runnerDestinationsFromPlay({
  entries,
  result,
  scoringRunners = [],
  outRunners = [],
  inningEndedOnThisPlay = false,
  play,
} = {}) {
  if (!play || !Array.isArray(entries) || !entries.length) return null
  const scorerKeys = new Set(scoringRunners.map(identityKey).filter(Boolean))
  const outKeys = new Set(outRunners.map(identityKey).filter(Boolean))
  const batterOut = BATTER_OUT_RESULTS.has(result)
  const destinations = []

  for (const entry of entries) {
    const key = identityKey(entry)
    let destination = scorerKeys.has(key) ? 'home' : null
    if (!destination && (outKeys.has(key) || (entry.isBatter && batterOut))) destination = 'out'

    if (!destination) {
      const telemetry = telemetryForEntry(play, entry)
      const base = telemetry?.bases_ran == null || play.truncated ? NaN : Number(telemetry.bases_ran)
      // RUNNERS KEEP MOVING AFTER A CAUGHT BALL, and the game's own bases_ran
      // follows them. Once the play has recorded the third out nothing they do
      // next is an advance: it is the animation running on while the fielders
      // jog in. This used to cover only a runner who crossed HOME, which left
      // the shorter version of the same fiction in place -- Peach's
      // 2026-08-31 lineout for the third out had Light Blue Yoshi "advance from
      // second to third" onto a base Goomba was already standing on.
      //
      // A runner who genuinely scored or was put out was resolved above, off
      // the tracker's own announcements, so this only ever holds a runner the
      // announcements said nothing about.
      if (inningEndedOnThisPlay && !entry.isBatter) destination = entry.origin
      else if (base >= 4) destination = 'home'
      else destination = BASE_BY_NUMBER[base] || null
    }

    // A fielder's choice can leave the batter at first even when a very old
    // capture lacks a usable BAT runner record. The result itself establishes
    // only this one runner's destination.
    if (!destination && entry.isBatter && result === 'FC') destination = 'first'
    if (!destination) return null
    const attemptedBase = destination === 'out' && !entry.isBatter
      ? attemptedBaseFromThrows(play, entry) : null
    destinations.push({
      id: entry.id, origin: entry.origin, isBatter: entry.isBatter, destination,
      ...(attemptedBase ? { attemptedBase } : {}),
    })
  }
  const occupied = destinations.map((row) => row.destination).filter((base) => BASE_NUMBER_BY_ORIGIN[base])
  if (new Set(occupied).size !== occupied.length) return null
  return destinations
}

const BASE_NUMBER_BY_ORIGIN = Object.freeze({ first: 1, second: 2, third: 3 })

/**
 * Did a runner already on base finish ahead of where they started?
 *
 * Returns true, false, or null when there is nothing that can answer it. The
 * null matters: a sacrifice bunt is scored on this fact, and "no capture was
 * running" must not read the same as "measured, and nobody moved".
 *
 * `bases_ran` is the runner's absolute base, so an advance is simply a bigger
 * number than the base they were standing on. A runner the tracker announced as
 * scoring advanced by definition and needs no play to prove it.
 */
export function runnerAdvancedOnPlay({
  runnersBefore = {}, scoringRunners = [], play = null,
} = {}) {
  const scorers = new Set(scoringRunners.map(identityKey).filter(Boolean))
  const origins = ['first', 'second', 'third'].filter((base) => runnersBefore[base])
  if (!origins.length) return false
  let measured = Boolean(play)
  for (const origin of origins) {
    const runner = runnersBefore[origin]
    const entry = typeof runner === 'string' ? { origin, characterName: runner } : { origin, ...runner }
    if (scorers.has(identityKey(entry))) return true
    const telemetry = telemetryForEntry(play, entry)
    const base = telemetry?.bases_ran == null || play?.truncated ? NaN : Number(telemetry.bases_ran)
    if (!Number.isFinite(base)) {
      measured = false
      continue
    }
    if (base > BASE_NUMBER_BY_ORIGIN[origin]) return true
  }
  return measured ? false : null
}
