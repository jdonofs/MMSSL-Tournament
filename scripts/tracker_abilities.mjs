// Which special ability a play actually USED -- as opposed to which one the
// character merely has.
//
// THE DISTINCTION THIS MODULE EXISTS FOR. Every character in Mario Super
// Sluggers has exactly one mapped fielding ability, and the mapping is a fact
// about the character, not about the play. Birdo has Suction Catch in every
// game she ever appears in, including the ones where she catches an ordinary
// fly ball standing still. Writing "Birdo used Suction Catch" from the mapping
// alone produces a sentence that is true about 100% of Birdo's catches and
// correct about far fewer, and an operator reading it has no way to tell which
// kind they are looking at.
//
// So a mapping is never evidence. An ability is named as USED only when the
// play carries deterministic activation evidence AND that evidence agrees with
// what the character is mapped to. Everything else is reported as what it is:
// the character is capable of it, and the tracker did not see it happen.
//
// WHAT COUNTS AS EVIDENCE TODAY. Very little, and that is stated rather than
// papered over:
//
//   star swing / star pitch   The tracker's own log announces these by name
//                             ("X used a star swing!"), so the event is
//                             observed and the character mapping supplies the
//                             name. This is the one path that reaches
//                             `confirmed`.
//   fielding action code 4    NOT a fielding ability at all. Every action-4
//                             window ever recorded belongs to a ball MARIO hit,
//                             and the operator names the mechanic: the Fire
//                             Swing fireball, which the first fielder to reach
//                             it cannot hold. It is the batter's ability acting
//                             on the fielder, exactly like Yoshi's egg (5), so
//                             it resolves to no fielding ability and charges
//                             the fielder with nothing.
//   a dive or a leap          The actor's `catch_type` byte says the fielder
//                             used the dive input (3) or leap input (6). For a
//                             character whose named ability is itself that
//                             reach animation, the move and activation are the
//                             same event. That includes the visible character-
//                             specific reaches: Yoshi's tongue, Birdo's
//                             suction, Magikoopa's wand, Kritter's keeper
//                             reach, Petey's Piranha Catch and the Bro throws.
//
//                             BUT: the game gives the player ONE dive/jump
//                             input, and a character whose mapped ability IS
//                             that move has no other way to perform it. So a
//                             dive by a Super Dive/Piranha Catch/Bro Throw
//                             character IS that character's named reach, and a
//                             leap by a Super Jump character IS Super Jump --
//                             not because the mapping alone is evidence, but
//                             because the observed input and the ability are
//                             the same act.
//   catch_type 5              CLAMBER. Every occurrence across the whole
//                             archive plus one live session belongs to a
//                             character mapped to Clamber -- Tiny Kong twice
//                             and Donkey Kong twice -- and to no one else,
//                             while those same Kongs also produce ordinary
//                             1/3/6/7 windows. One of the live pair is an
//                             operator-confirmed wall climb. It is treated as
//                             an activation, and a type-5 window on a
//                             character NOT mapped to Clamber is reported as a
//                             mismatch rather than quietly renamed.
//   an actual throw           Quick Throw is intrinsic to every throw by a
//                             mapped character. Laser Beam is intrinsic to a
//                             mapped character's throw to home.
//   everything else           No activation signal exists.
//
// BALL DASH IS NOT AN ACTIVATION AND NEVER WAS. It has no move, no animation
// and no input: a Noki or a Goomba carrying the ball simply runs faster than
// they otherwise would. There is nothing for the capture to witness, so the
// two claims this module is built to separate -- "has it" and "used it" --
// collapse into one, and both the sentence "used Ball Dash" and the finding
// "the tracker never saw Ball Dash" were reporting a distinction that does not
// exist. It is a PASSIVE ability: named whenever a mapped character carries
// the ball, never counted as unobserved, and never claimed as a move.
//
// Throw abilities are confirmed separately from approach events.

import { rosterCharacterName } from './tracker_character_ids.mjs'
import {
  CHARACTER_BASERUNNING_ABILITY,
  CHARACTER_FIELDING_ABILITY,
  CHARACTER_STAR_PITCH,
  CHARACTER_STAR_SWING,
  FIELDING_ABILITY_DEFENSE_BONUS,
} from '../src/data/characterAbilities.js'

// The action enum on the fielder actor, as derive_player_metrics.py classifies
// it. Kept in step with FIELDING_ACTION_* there; the names are duplicated
// rather than imported because that file is Python.
export const FIELDING_ACTION_CODES = Object.freeze({
  1: 'secure',
  2: 'ordinary_misplay',
  3: 'ordinary_misplay',
  4: 'star_ball',
  5: 'yoshi_egg',
  7: 'buddy_handoff',
})

// The APPROACH enum (`catch_type`, actor +0x2AC) mapped to the ability that
// approach can only be. Each entry names the ability a character must be
// mapped to for the observation to count as that ability firing; an approach
// by anyone else is just an approach.
//
//   3 dive -> Super Dive   one dive input, so a Super Dive character diving is
//   6 leap -> Super Jump   using it. Anyone else is diving or jumping plainly.
//   5      -> Clamber      an approach no non-Clamber character has ever
//                          produced in any recorded session.
export const CATCH_TYPE_ABILITIES = Object.freeze({
  3: 'Super Dive',
  5: 'Clamber',
  6: 'Super Jump',
})

// These are character-specific names for the same observed dive input. The
// Bro variants have distinct official names; collapsing all three to Hammer
// Throw made Fire Bro and Boomerang Bro narrations wrong.
export const DIVE_FIELDING_ABILITIES = Object.freeze(new Set([
  'Super Dive',
  'Tongue Catch',
  'Magical Catch',
  'Suction Catch',
  'Piranha Catch',
  'Keeper Catch',
  'Hammer Throw',
  'Fireball Throw',
  'Boomerang Throw',
]))

// Every named fielding ability has one explicit activation rule. Keeping this
// as data makes omissions visible immediately instead of letting a roster entry
// silently remain narrative-dead.
export const FIELDING_ABILITY_ACTIVATION = Object.freeze({
  'Super Dive': 'dive_reach',
  'Tongue Catch': 'dive_reach',
  'Magical Catch': 'dive_reach',
  'Ball Dash': 'passive_carry_speed',
  'Laser Beam': 'throw_home',
  'Quick Throw': 'throw',
  'Super Jump': 'leap',
  'Suction Catch': 'dive_reach',
  'Piranha Catch': 'dive_reach',
  Clamber: 'clamber',
  'Keeper Catch': 'dive_reach',
  'Hammer Throw': 'dive_reach',
  'Fireball Throw': 'dive_reach',
  'Boomerang Throw': 'dive_reach',
})

// Abilities with no activation event to observe, because they have no move.
// A passive ability applies whenever its precondition holds -- Ball Dash while
// a mapped character carries the ball -- so the mapping IS the fact, and there
// is nothing for a capture to confirm or to miss.
export const PASSIVE_FIELDING_ABILITIES = Object.freeze(new Set([
  'Ball Dash',
]))

// Clamber's own approach code. Unlike a dive or a leap, nothing else in the
// game produces it, so a type-5 window on a character who cannot Clamber is a
// contradiction worth surfacing rather than an ordinary play.
export const CLAMBER_CATCH_TYPE = 5

// How an activation was established. `confirmed` is the only one that licenses
// naming the ability as used.
export const ACTIVATION_STATUSES = Object.freeze([
  'confirmed',       // observed activation that agrees with the mapping
  'standard',        // observed, and the roster's name for it is 'Standard'
  'passive',         // the ability has no activation event; the mapping is it
  'unresolved',      // a special action fired, but it is not mapped to a name
  'unconfirmed',     // the character has the ability; nothing says it fired
  'mismatch',        // observed activation names something the mapping denies
  'not_applicable',  // the character has no ability of this kind
])

// Punctuation is stripped, not just case and whitespace. The roster keys its
// ability tables as 'hammer bro' and 'king k rool' while both the tracker log
// and the 60 Hz capture use the game's own spelling -- 'Hammer Bro.', 'King K.
// Rool', 'Bowser Jr.'. Matching on a trim alone missed every one of them, so
// five characters in a single game resolved to "no ability at all" and every
// sentence about them was silently dropped. This is the same normalization
// tracker_character_ids.mjs uses to join names across the two feeds.
function normalize(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

// Each ability table re-keyed on the normalized name, built once.
const NORMALIZED_TABLES = new WeakMap()

function normalizedTable(table) {
  let index = NORMALIZED_TABLES.get(table)
  if (!index) {
    index = new Map()
    for (const [key, value] of Object.entries(table)) index.set(normalize(key), value)
    NORMALIZED_TABLES.set(table, index)
  }
  return index
}

/** The table's raw entry for this character, 'None' and 'Standard' included. */
function rawAbility(table, characterName) {
  // Through the roster alias first. Punctuation normalization is not enough for
  // the two characters the game names differently from the roster: the capture
  // writes 'Red Koopa Troopa' and the roster keys 'red koopa', which normalize
  // to different strings. That miss reported a non-captain's ordinary star
  // swing as one the roster could not name, on every star he hit.
  const name = rosterCharacterName(characterName)
  return normalizedTable(table).get(normalize(name)) ?? null
}

function lookup(table, characterName) {
  const value = rawAbility(table, characterName)
  return value && value !== 'None' && value !== 'Standard' ? value : null
}

/** The fielding ability this character is mapped to, or null for 'None'. */
export function fieldingAbilityFor(characterName) {
  return lookup(CHARACTER_FIELDING_ABILITY, characterName)
}

export function baserunningAbilityFor(characterName) {
  return lookup(CHARACTER_BASERUNNING_ABILITY, characterName)
}

export function starPitchFor(characterName) {
  return lookup(CHARACTER_STAR_PITCH, characterName)
}

export function starSwingFor(characterName) {
  return lookup(CHARACTER_STAR_SWING, characterName)
}

/** Whether a name is one of the repository's known fielding abilities. */
export function isKnownFieldingAbility(name) {
  return Object.hasOwn(FIELDING_ABILITY_DEFENSE_BONUS, String(name ?? ''))
}

// Fail during development if either table grows without the other. A partial
// ability list is worse than a loud failure because it produces plausible but
// incomplete play descriptions.
for (const ability of Object.values(CHARACTER_FIELDING_ABILITY)) {
  if (!isKnownFieldingAbility(ability)) {
    throw new Error(`Unknown fielding ability in character roster: ${ability}`)
  }
}
for (const ability of Object.keys(FIELDING_ABILITY_DEFENSE_BONUS)) {
  if (ability !== 'None' && !Object.hasOwn(FIELDING_ABILITY_ACTIVATION, ability)) {
    throw new Error(`Fielding ability has no activation rule: ${ability}`)
  }
}

// THE LASER BEAM IS MEASURED, NOT INFERRED FROM SPEED.
//
// This used to be a speed gate, LASER_BEAM_MIN_MPH = 100, calibrated off a
// single labelled throw at 105.7 mph on the reasoning that throw speeds are
// quantised and nothing lived between 90.1 and 105.7. Daisy Cruiser 2026-09-04
// falsified that in one game, from both sides at once:
//
//   Blue Pianta's throw home, LABELLED a Laser Beam by the operator:  84.5 mph
//   Mario's two ordinary throws home in the same game:          84.6, 84.8 mph
//   Wiggler, who has no Laser Beam, throwing home:                    93.2 mph
//
// A confirmed false negative and a populated "empty" band. Peak speed does not
// separate the move from an ordinary throw, so no threshold can.
//
// The game says so itself. `laser_throw` on the throw record is the state byte
// at 0x900D9AF5, up for exactly the flight of a Laser Beam throw and zero
// otherwise -- release-frame exact and flight-length exact on the labelled
// throws at DK Jungle and Daisy Cruiser, and silent for the whole of the Yoshi
// Park session where the operator wrote that Red Pianta's throw home was NOT
// one. See STATE_FIELDS in scripts/collect_player_tracking.py.
//
// The MAPPING still has to agree. The flag says a Laser Beam fired; the roster
// says who can throw one. A flag on a character with no Laser Beam would be a
// disagreement worth seeing rather than a confirmation, so it is not confirmed
// on the flag alone.
//
// A session with no measured flag at all -- an older capture replayed through a
// derivation that predates it -- returns 'unconfirmed' rather than guessing,
// which is what the honest answer was for those sessions all along.

export function resolveThrowingAbility({
  characterName, targetBase = null, buddyThrow = false, peakSpeedMph = null,
  laserThrow = null,
} = {}) {
  const mapped = fieldingAbilityFor(characterName)
  if (buddyThrow || !mapped) return null

  if (mapped === 'Quick Throw') {
    return {
      status: 'confirmed',
      abilityName: mapped,
      mappedAbility: mapped,
      evidence: 'mapped_quick_throw_character_completed_a_non_buddy_throw',
    }
  }
  if (mapped === 'Laser Beam') {
    const mph = Number(peakSpeedMph)
    const speed = Number.isFinite(mph) ? mph : null
    // The game raised its flag AND the roster says this character can throw
    // one. Neither half alone is the answer: the flag without the mapping is a
    // disagreement to look at, and the mapping without the flag is what made
    // the console assert Laser Beam on every Pianta throw home.
    if (laserThrow === true) {
      return {
        status: 'confirmed',
        abilityName: mapped,
        mappedAbility: mapped,
        evidence: 'the_game_raised_its_laser_throw_flag_for_this_throw',
        peakSpeedMph: speed,
      }
    }
    // Only claim the move did NOT fire where it could have. A mapped character
    // throwing to a base other than home is not a missed Laser Beam, and
    // saying so on every routine throw is noise.
    if (laserThrow === false && targetBase === 'home') {
      return {
        status: 'unconfirmed',
        abilityName: mapped,
        mappedAbility: mapped,
        evidence: 'mapped_laser_beam_character_threw_home_and_the_game_raised_no_laser_throw_flag',
        peakSpeedMph: speed,
      }
    }
    // No measurement at all: a session derived before the flag was named. The
    // speed is reported because it is what there is, never as the ruling.
    if (laserThrow == null && targetBase === 'home') {
      return {
        status: 'unconfirmed',
        abilityName: mapped,
        mappedAbility: mapped,
        evidence: 'no_laser_throw_flag_was_measured_for_this_throw',
        peakSpeedMph: speed,
      }
    }
    return null
  }
  return null
}

/**
 * Ball Dash on a measured carry -- as a passive, never as an activation.
 *
 * The ability is a speed bonus and nothing else, so a mapped character who
 * carries the ball is using it by definition and one who never carries has not
 * failed to use it. `status` is therefore 'passive': the narrative may name it
 * on the carry, and no check anywhere may count it as unobserved.
 *
 * The one-unit floor is still here, and it is about the SENTENCE, not the
 * ability: a fielder who caught the ball and stood still travelled no distance
 * worth a line of narrative.
 *
 * `motion` is the deriver's judgement of who moved whom. A fielder driven
 * backwards by the force of the hit covers ground while holding the ball and
 * is not running: crediting that as Ball Dash reported a carry-speed bonus for
 * standing still and being shoved, which the operator flagged twice at DK
 * Jungle. Only a self-directed 'carry' is evidence of the passive.
 */
export function resolveCarryAbility({
  characterName, distanceUnits = null, peakSpeedUnitsPerSecond = null,
  motion = 'carry',
} = {}) {
  const mapped = fieldingAbilityFor(characterName)
  const distance = Number(distanceUnits)
  if (mapped !== 'Ball Dash' || !Number.isFinite(distance) || distance < 1) return null
  if (motion === 'knockback') return null
  const peakSpeed = Number(peakSpeedUnitsPerSecond)
  return {
    status: 'passive',
    abilityName: mapped,
    mappedAbility: mapped,
    distanceUnits: distance,
    peakSpeedUnitsPerSecond: Number.isFinite(peakSpeed) ? peakSpeed : null,
    evidence: 'ball_dash_is_a_passive_carry_speed_bonus_and_this_mapped_character_carried_the_ball',
  }
}

/**
 * Resolve one fielding event into an ability claim the narrative may make.
 *
 * `observedAbilityName` is for a future signal that names an ability directly.
 * Nothing produces one today, and that is exactly why the parameter exists
 * rather than the mapping being consulted as though it were one.
 *
 * Returns { status, abilityName, mappedAbility, actionCode, evidence, text }
 * where `abilityName` is non-null ONLY when status is 'confirmed'.
 */
export function resolveFieldingAbility({
  characterName,
  actionCode = null,
  observedAbilityName = null,
  observedDive = false,
  observedLeap = false,
  catchType = null,
} = {}) {
  const mapped = fieldingAbilityFor(characterName)
  const mechanic = actionCode == null ? null : FIELDING_ACTION_CODES[actionCode] ?? null

  if (Number(catchType) === 3 && mapped && DIVE_FIELDING_ABILITIES.has(mapped)) {
    return {
      status: 'confirmed',
      abilityName: mapped,
      mappedAbility: mapped,
      actionCode,
      catchType,
      observedDive: true,
      observedLeap: false,
      evidence: `catch_type_3_is_the_dive_input_and_${mapped.replace(/\s+/g, '_').toLowerCase()}_is_this_character_dive_reach`,
    }
  }

  // The approach the actor actually took. When it can only be one ability and
  // the character is mapped to that ability, the activation is observed: there
  // is no separate input that would let them do the move without the ability.
  const approachAbility = catchType == null ? null : CATCH_TYPE_ABILITIES[catchType] ?? null
  if (approachAbility) {
    if (mapped && normalize(approachAbility) === normalize(mapped)) {
      return {
        status: 'confirmed',
        abilityName: mapped,
        mappedAbility: mapped,
        actionCode,
        catchType,
        observedDive: Boolean(observedDive),
        observedLeap: Boolean(observedLeap),
        evidence: `catch_type_${catchType}_is_${mapped.replace(/\s+/g, '_').toLowerCase()}_and_the_character_maps_to_it`,
      }
    }
    // Clamber's approach belongs to nobody else, so seeing it on a character
    // who cannot Clamber is a contradiction rather than an ordinary reach.
    // A dive or a leap by a character mapped to something else is neither --
    // it falls through and is reported as the plain approach it is.
    if (catchType === CLAMBER_CATCH_TYPE) {
      return {
        status: 'mismatch',
        abilityName: null,
        mappedAbility: mapped,
        observedAbilityName: approachAbility,
        actionCode,
        catchType,
        evidence: 'clamber_approach_observed_on_a_character_not_mapped_to_clamber',
      }
    }
  }

  if (observedAbilityName) {
    // An observed activation that the character cannot have is a contradiction
    // worth surfacing, not a name to print.
    if (mapped && normalize(observedAbilityName) === normalize(mapped)) {
      return {
        status: 'confirmed',
        abilityName: mapped,
        mappedAbility: mapped,
        actionCode,
        evidence: 'observed_activation_matches_character_mapping',
      }
    }
    return {
      status: 'mismatch',
      abilityName: null,
      mappedAbility: mapped,
      observedAbilityName,
      actionCode,
      evidence: 'observed_activation_disagrees_with_character_mapping',
    }
  }

  // Action 4 is a BATTER's ability acting on this fielder -- Mario's fireball,
  // the same shape as Yoshi's egg -- not a fielding ability of theirs. Reported
  // as an unresolved special action, it attached the fielder's own mapped
  // ability to the sentence and read as Blue Yoshi having used Tongue Catch on
  // a ball he never had a play on.
  if (mechanic === 'star_ball') {
    return {
      status: 'not_applicable',
      abilityName: null,
      mappedAbility: mapped,
      actionCode,
      evidence: 'fielding_action_code_4_is_the_batters_star_ball_forcing_the_contact',
    }
  }

  // A code this table has no name for. Reported with its raw value rather than
  // guessed at -- which is exactly how code 4 was carried until the operator
  // named it, and is why naming it cost nothing to recover.
  if (Number(actionCode) > 0 && !mechanic) {
    return {
      status: 'unresolved',
      abilityName: null,
      mappedAbility: mapped,
      actionCode,
      evidence: `fielding_action_code_${actionCode}_not_mapped_to_an_ability`,
    }
  }

  if (!mapped) {
    return {
      status: 'not_applicable',
      abilityName: null,
      mappedAbility: null,
      actionCode,
      evidence: 'character_has_no_mapped_fielding_ability',
    }
  }

  // A passive ability has no event to wait for, so 'unconfirmed' would be
  // reporting a missing observation that can never be made.
  if (PASSIVE_FIELDING_ABILITIES.has(mapped)) {
    return {
      status: 'passive',
      abilityName: mapped,
      mappedAbility: mapped,
      actionCode,
      catchType,
      evidence: `${mapped.replace(/\s+/g, '_').toLowerCase()}_is_passive_and_has_no_activation_event`,
    }
  }

  return {
    status: 'unconfirmed',
    abilityName: null,
    mappedAbility: mapped,
    actionCode,
    catchType,
    observedDive: Boolean(observedDive),
    observedLeap: Boolean(observedLeap),
    evidence: observedDive
      ? 'dive_observed_but_this_character_is_not_mapped_to_a_named_dive_reach'
      : observedLeap
        ? 'leap_observed_but_this_character_is_not_mapped_to_super_jump'
        : 'character_mapping_only_no_activation_signal',
  }
}

/**
 * A star swing or star pitch the tracker announced by name.
 *
 * This is the one place a mapping legitimately supplies a name, because the
 * activation itself was observed -- the tracker printed "X used a star swing!"
 * -- and the mapping only says which of the thirteen swings that character's is.
 */
export function resolveStarAbility({ characterName, used, kind }) {
  const table = kind === 'pitch' ? CHARACTER_STAR_PITCH : CHARACTER_STAR_SWING
  const mapped = kind === 'pitch' ? starPitchFor(characterName) : starSwingFor(characterName)
  if (!used) {
    return { status: 'not_applicable', abilityName: null, mappedAbility: mapped, evidence: 'no_star_event_in_this_plate_appearance' }
  }
  // 'Standard' is not a missing name. Only captains have their own star swing
  // and star pitch; every non-captain shares the one generic version, and the
  // roster records that as 'Standard'. Reporting it as unresolved said "the
  // tracker does not know" about something the tracker does know, on every
  // non-captain star in every game.
  if (!mapped && normalize(rawAbility(table, characterName)) === 'standard') {
    return {
      status: 'standard',
      abilityName: null,
      mappedAbility: 'Standard',
      evidence: 'non_captains_share_the_standard_star_and_the_roster_records_it_as_such',
    }
  }
  if (!mapped) {
    // The game announced a star, and the roster does not know which one this
    // character throws or swings. Naming it would be invention.
    return {
      status: 'unresolved',
      abilityName: null,
      mappedAbility: null,
      evidence: 'tracker_announced_a_star_but_the_character_has_no_mapped_name',
    }
  }
  return {
    status: 'confirmed',
    abilityName: mapped,
    mappedAbility: mapped,
    evidence: kind === 'pitch'
      ? 'tracker_announced_a_star_pitch_and_the_character_maps_to_one'
      : 'tracker_announced_a_star_swing_and_the_character_maps_to_one',
  }
}
