// What is still missing from the calibration, and the one game that best fills it.
//
//   node scripts/next_calibration_game.mjs
//   node scripts/next_calibration_game.mjs --status      (report only, write nothing)
//
// WHY ONE GAME AT A TIME. A schedule of eighteen games planned in advance is a
// schedule built on a yield estimate, and a real game does not honour it: balls
// go where they go, a character can field for nine innings and be thrown four
// chances, a session can end early. Planning the eighteenth game before the
// first has been played commits to a guess about seventeen games of results.
//
// So this reads the archive as it actually stands, reports how far every metric
// is from being calibrated, and emits the single next game that most reduces
// the gap. Play it, and run this again -- the next recommendation is computed
// from a strictly better-informed position. It stops when every requirement is
// met and says so.
//
// The rosters are written into the game's memory by scripts/mss_autoteam.py, so
// nobody selects them by hand. They are printed here because the operator still
// needs to know who is on the field to judge what the session produced.

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { createClient } from '@supabase/supabase-js'
import { CHARACTER_VARIANTS, getChemistry, chemistryNamesMatch } from '../src/data/chemistry.js'
import { STADIUM_NAME_TO_KEY } from '../src/utils/stadiums.js'
import {
  CAPTAIN_CHAR_INDEXES,
  LAST_WRITABLE_CHAR_INDEX,
  POSITIONS,
  STADIUMS,
  siteNameToCharIndex,
  stadiumTimeOfDay,
} from './mss_roster.mjs'
import { normalizeCharacterName, rosterCharacterName } from './tracker_character_ids.mjs'

const TRACKING_DIR = path.resolve('data/player_tracking')
const OUT_FILE = path.resolve('data/calibration/next-game.json')

// A Mii cannot be written into the formation struct -- doing so hangs the
// emulated machine -- so it is taken by cursor, only for a player it is mapped
// to. These lineups have no player behind them.
const EXCLUDED = new Set(['Mii'])

// WHAT "CALIBRATED" MEANS, PER METRIC. Each is a per-character sample count and
// the threshold below which that character's number is mostly the attribute
// prior rather than a measurement. They are not equal because the metrics are
// not equally noisy: arm strength reproduces at 0.86 against the game's own
// throwing_speed on a handful of throws, while a fielding chance is one binary
// outcome and needs many more.
const REQUIREMENTS = [
  { key: 'fielding', label: 'primary fielding chances', target: 20 },
  { key: 'batting', label: 'batted balls in play', target: 20 },
  { key: 'pitching', label: 'measured pitches', target: 20 },
  { key: 'arm', label: 'non-Buddy throws', target: 10 },
  { key: 'running', label: 'qualifying runs (15u+)', target: 8 },
]

// A park is a different fence, a different wall height and a different set of
// catch geometries, so the difficulty curve has to be seen in all nine or it is
// fitted to whichever ones got played.
const PARK_TARGET = 2

// Chemistry is a treatment and needs its own exposure: Buddy Throws, Buddy
// Jumps and buddy handoffs only happen on a good pairing, and the throw-accuracy
// drift only shows on a bad one. Counted in TEAM-games, since each game fields
// two independent rosters.
const CHEMISTRY_TARGETS = { good: 6, bad: 3 }

// A team counts as a chemistry treatment only past this many net links -- one
// stray pairing on an otherwise neutral roster is not an exposure.
const CHEMISTRY_NET_THRESHOLD = 3

// A run has to be long enough to reach top speed before it says anything about
// how fast a character is.
const MIN_RUN_UNITS = 15

// Stadium research rides alongside ordinary calibration games. These are test
// objectives, not tracker output: the operator labels a positive or control
// play and the normal 60 Hz capture preserves the evidence for later mining.
// Named stadium events stay gated off until every park has a stable signal.
const STADIUM_TEST_OBJECTIVES = Object.freeze({
  'Mario Stadium': {
    all: [
      ['no_gimmick_control', 'Record ordinary balls to each field as the no-gimmick control.'],
    ],
  },
  'Wario City': {
    all: [
      ['directional_arrow_redirect', 'Trigger and label a directional-arrow redirect.'],
      ['manhole_water', 'Trigger and label a manhole water launch or knockdown.'],
      ['hazard_near_miss_control', 'Label a similar ball that passes a hazard without triggering it.'],
    ],
  },
  'Peach Ice Garden': {
    all: [
      ['freezie_ball_collision', 'Hit a Freezie and label the ball response.'],
      ['freezie_break', 'Break a Freezie and label whether any player was frozen.'],
      ['freezie_player_freeze', 'Freeze a fielder and label the affected player.'],
      ['freezie_near_miss_control', 'Label a nearby ball that does not touch a Freezie.'],
    ],
    night: [
      ['snowflake_blackout', 'Hit the hanging snowflake and label the blackout/spotlight interval.'],
    ],
  },
  'Daisy Cruiser': {
    day: [
      ['table_collision', 'Hit a table and label the ball response.'],
      ['table_break', 'Break a table and label the exact table if distinguishable.'],
      ['table_player_stun', 'Slide a fielder into a table and label the stun.'],
    ],
    night: [
      ['cheep_cheep_collision', 'Trigger and label a Cheep Cheep collision.'],
      ['gooper_blooper_tilt', 'Label the beginning and end of a Gooper Blooper field tilt.'],
    ],
    all: [
      ['hazard_near_miss_control', 'Label a similar play with no stadium interaction.'],
    ],
  },
  'Yoshi Park': {
    day: [
      ['pipe_entry_exit', 'Send a ball through a pipe and label both source and destination.'],
      ['pipe_player_stun', 'Run or dive a fielder into a pipe and label the stun.'],
      ['train_collision', 'Trigger and label a train collision.'],
    ],
    night: [
      ['piranha_ball_eat_spit', 'Have a Piranha Plant eat and spit a ball; label both phases.'],
      ['piranha_player_hit', 'Trigger and label a Piranha Plant player hit.'],
      ['wiggler_train_collision', 'Trigger and label a Wiggler train collision.'],
    ],
    all: [
      ['hazard_near_miss_control', 'Label a similar play with no stadium interaction.'],
    ],
  },
  'DK Jungle': {
    all: [
      ['root_slowdown', 'Roll a ball across roots and label the slowdown interval.'],
      ['barrel_collision', 'Trigger and label a barrel collision.'],
      ['flower_gas', 'Trigger flower gas and label the affected player and recovery.'],
      ['hazard_near_miss_control', 'Label a similar play with no stadium interaction.'],
    ],
    night: [
      ['flaming_barrel_collision', 'Trigger and label a flaming-barrel collision or burn.'],
      ['dk_statue_pow', 'Trigger and label the DK-statue POW stun.'],
    ],
  },
  "Luigi's Mansion": {
    all: [
      ['gravestone_hit', 'Hit a gravestone and label the exact impact.'],
      ['ghost_attack', 'Trigger and label a ghost attack and affected player.'],
      ['tall_grass_concealment', 'Send a ball into tall grass and label concealment start/end.'],
      ['hazard_near_miss_control', 'Label a similar play with no stadium interaction.'],
    ],
  },
  'Bowser Jr. Playroom': {
    all: [
      ['thwomp_impact_break', 'Hit and break a Thwomp; label impact and break.'],
      ['chain_chomp_spawn', 'Trigger and label a Chain Chomp spawn.'],
      ['chain_chomp_hit', 'Label a Chain Chomp hit, affected player and ball outcome.'],
      ['bullet_bill_spawn', 'Trigger and label a Bullet Bill spawn.'],
      ['bullet_bill_hit', 'Label a Bullet Bill hit, affected player and ball outcome.'],
      ['hazard_near_miss_control', 'Label a similar play with no stadium interaction.'],
    ],
  },
  'Bowser Castle': {
    all: [
      ['podoboo_burn_drop', 'Trigger and label a Podoboo burn/drop.'],
      ['bowser_statue_fire', 'Trigger and label Bowser-statue fire.'],
      ['thwomp_block', 'Trigger and label a Thwomp ball block.'],
      ['fireball_puddle_burn', 'Trigger and label a fireball puddle/burn.'],
      ['king_bob_omb_bomb', 'Trigger and label a King Bob-omb explosion.'],
      ['hazard_near_miss_control', 'Label a similar play with no stadium interaction.'],
    ],
  },
})

function stadiumTestCard(stadiumName, isNight) {
  const configured = STADIUM_TEST_OBJECTIVES[stadiumName] || {}
  const rows = [...(configured.all || []), ...(configured[isNight ? 'night' : 'day'] || [])]
  return {
    schemaVersion: 1,
    status: 'evidence_collection_only',
    variant: isNight ? 'night' : 'day',
    repeatTarget: 3,
    annotationNoteFormat: 'stadium_event=<objective id>; outcome=<what happened>; control=<yes|no>',
    objectives: rows.map(([id, instruction]) => ({
      id,
      instruction,
      // Every objective here is a stadium event, control plays included --
      // the category is what makes them countable, and `control=yes` in the
      // note is what separates a negative from a positive.
      annotationCategory: 'stadium_event',
    })),
  }
}

function parseArgs(argv) {
  const args = { statusOnly: false, out: OUT_FILE, stadium: null, night: null, include: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--status') args.statusOnly = true
    else if (token === '--out') args.out = path.resolve(argv[index += 1])
    // A STAR-SWING TEST NEEDS NAMED BATTERS. Bowser Jr.'s paint or Peach's heart
    // only happens with that captain in the lineup, and a cast picked for
    // coverage will not put them there. Comma-separated names.
    else if (token === '--include') {
      args.include = String(argv[index += 1] || '').split(',')
        .map((name) => name.trim()).filter(Boolean)
    }
    // A NAMED PARK IS A DIFFERENT QUESTION FROM CALIBRATION COVERAGE. The five
    // per-character requirements are all met, so "the park with the fewest
    // sessions" is no longer the game worth playing -- but the stadium-event
    // gate is still shut, and closing it means playing a NAMED park in a NAMED
    // variant until its hazard has a signal. That is what these two are for,
    // and it is why they also lift the "calibration complete, stop" exit: the
    // cast, the position assignment, the chemistry split and the lineup schema
    // are still exactly what this planner builds, and rebuilding them by hand
    // somewhere else is how the two would drift apart.
    else if (token === '--stadium') args.stadium = argv[index += 1]
    else if (token === '--night') args.night = true
    else if (token === '--day') args.night = false
    else throw new Error(`Unknown option ${token}`)
  }
  if (args.stadium) {
    const matched = STADIUMS.find(
      (name) => name.toLowerCase() === args.stadium.toLowerCase())
    if (!matched) {
      throw new Error(`Unknown stadium "${args.stadium}". `
        + `One of: ${STADIUMS.join(', ')}`)
    }
    args.stadium = matched
  }
  return args
}

function loadEnv(filePath) {
  const env = {}
  if (!fs.existsSync(filePath)) return env
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq > 0) env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
  }
  return env
}

/** +1 good, -1 bad, 0 none. Links are not stored symmetrically, so OR both. */
function chemistryLink(left, right) {
  const a = getChemistry(left) || { good: [], bad: [] }
  const b = getChemistry(right) || { good: [], bad: [] }
  if (a.bad.some((n) => chemistryNamesMatch(n, right))
    || b.bad.some((n) => chemistryNamesMatch(n, left))) return -1
  if (a.good.some((n) => chemistryNamesMatch(n, right))
    || b.good.some((n) => chemistryNamesMatch(n, left))) return 1
  return 0
}

function teamChemistry(names) {
  let net = 0
  let links = 0
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const value = chemistryLink(names[i], names[j])
      net += value
      if (value !== 0) links += 1
    }
  }
  return { net, links }
}

/**
 * Everything the archive already contains, counted the way the models count it.
 *
 * The chemistry exposure is read back out of the recorded fielding alignments
 * rather than from any plan: what matters is which rosters were actually on the
 * field, not which ones were intended to be.
 */
/**
 * Translate a name the 60 Hz capture wrote into the site's spelling of it.
 *
 * THE CAPTURE AND THE SITE DO NOT AGREE ON SPELLING, and six characters differ:
 * the capture writes Koopa Troopa, Red Koopa Troopa, Fire Bro., Hammer Bro.,
 * Boomerang Bro. and Light Blue Yoshi; the roster writes Koopa, Red Koopa, Fire
 * Bro, Hammer Bro, Boomerang Bro and Light-Blue Yoshi. `readArchive` keyed its
 * counts on the first set and `countsFor` looked them up with the second, so
 * those six read as zero on every metric no matter how much they played --
 * `need` returned the maximum 5.0, and they were locked into the top 18 of
 * every game this script has ever proposed. Fire Bro. had been on the field for
 * 14 of 22 sessions and still came back as "furthest behind".
 *
 * Nothing new is invented here: `rosterCharacterName` already owns the two
 * Koopa aliases, and the remaining four agree once punctuation and case are
 * dropped, which is what `normalizeCharacterName` does. The site's own list is
 * the authority for the final spelling, so chemistry -- which matches exact
 * roster names -- resolves too.
 */
function siteNameResolver(playable) {
  const byNormalized = new Map(
    playable.map((character) => [normalizeCharacterName(character.name), character.name]),
  )
  const unmatched = new Set()
  const resolve = (name) => {
    if (!name) return name
    const key = normalizeCharacterName(rosterCharacterName(name))
    const site = byNormalized.get(key)
    // Falling back to the raw name keeps a genuinely unknown capture name (an
    // unnamed id, a Mii) visible as unmatched instead of quietly folded in.
    if (!site) unmatched.add(name)
    return site || name
  }
  // THE LIVE GUARD on the alias table. tests/character-names.test.mjs checks
  // every name table in the repo against a fixture; this is the half that only
  // a live run can see -- a character added to public.characters, or renamed,
  // or a capture spelling nobody has met yet. Anything listed here is counted
  // as its own person and will read as never measured, exactly as the six
  // Bros and Koopas did before the alias table reached this script.
  resolve.unmatched = unmatched
  return resolve
}

function readArchive(siteName = (name) => name) {
  const counts = new Map()
  const positionsPlayed = new Map()
  // How many sessions each character has been ON THE FIELD for, which is not
  // the same as how much was measured of them: a character can play nine
  // innings at first base and be thrown four chances. Used only to break ties.
  const sessionsPlayed = new Map()
  const parks = new Map()
  const chemistry = { good: 0, bad: 0, neutral: 0 }
  const bump = (name, key, by = 1) => {
    if (!name) return
    if (!counts.has(name)) {
      counts.set(name, Object.fromEntries(REQUIREMENTS.map((r) => [r.key, 0])))
    }
    counts.get(name)[key] += by
  }
  if (!fs.existsSync(TRACKING_DIR)) {
    return { counts, positionsPlayed, sessionsPlayed, parks, chemistry, sessions: 0 }
  }

  const allPlayFiles = fs.readdirSync(TRACKING_DIR).filter((n) => n.endsWith('.plays.jsonl'))
  const excludedStems = new Set(allPlayFiles
    .map((file) => file.replace(/\.plays\.jsonl$/, ''))
    .filter((stem) => sessionIsExcluded(stem)))
  const playFiles = allPlayFiles.filter(
    (file) => !excludedStems.has(file.replace(/\.plays\.jsonl$/, '')))

  // BEING ON THE FIELD STILL COUNTS AS BEING ON THE FIELD. `sessionsPlayed` is
  // not a measurement -- it is the tie-break that decides who plays next when
  // `need` cannot separate two characters, and it exists to stop the same faces
  // being picked every game. Excluding research sessions from it made exactly
  // that bug: two Wario City nights in a row returned the identical eighteen,
  // because nobody who played them was recorded as having played.
  //
  // So the METRICS skip an excluded session and this does not. A character who
  // spent nine innings watching balls go past has had their turn, whatever the
  // session taught us about fielding.
  for (const file of allPlayFiles) {
    const sides = new Map()
    for (const line of fs.readFileSync(path.join(TRACKING_DIR, file), 'utf8').split('\n')) {
      if (!line.trim()) continue
      const play = JSON.parse(line)
      const side = play.inning_half
      const seen = sides.get(side) || new Map()
      for (const [position, entry] of Object.entries(play.fielders || {})) {
        if (entry?.character) seen.set(position, entry.character)
      }
      sides.set(side, seen)
    }
    const onField = new Set()
    for (const seen of sides.values()) {
      for (const who of seen.values()) onField.add(siteName(who))
    }
    for (const who of onField) {
      if (who) sessionsPlayed.set(who, (sessionsPlayed.get(who) || 0) + 1)
    }
  }

  for (const file of playFiles) {
    const stem = file.replace(/\.plays\.jsonl$/, '')
    const park = sessionParkKey(stem)
    parks.set(park, (parks.get(park) || 0) + 1)
    const onField = new Set()
    // Each session fields two nine-man defences. Collect them by the set of
    // characters seen at each position on each half-inning side.
    const sides = new Map()
    for (const line of fs.readFileSync(path.join(TRACKING_DIR, file), 'utf8').split('\n')) {
      if (!line.trim()) continue
      const play = JSON.parse(line)

      const primary = play.primary_fielder
      const primaryFielder = primary ? (play.fielders || {})[primary] : null
      // A frozen fielder is disqualified for the same reason a forced misplay
      // is: the chance was decided by something other than the fielder. He was
      // held where he stood for two seconds while the ball went somewhere, and
      // counting that toward his fielding sample measures the freeze.
      if (primaryFielder && primaryFielder.character
        && primaryFielder.distance_to_landing_units != null && play.hang_time_s
        && !primaryFielder.deflected && !primaryFielder.forced_misplay
        && !primaryFielder.frozen_frames) {
        bump(siteName(primaryFielder.character), 'fielding')
      }

      if (['fair_in_play', 'fair_caught', 'home_run', 'home_run_robbed']
        .includes(play.batted_ball_class)) {
        bump(siteName(play.batter), 'batting')
      }

      for (const record of play.throws || []) {
        if (record.is_throw !== false && record.peak_speed_mph && !record.buddy_throw) {
          bump(siteName(record.thrower_character), 'arm')
        }
      }

      for (const runner of Object.values(play.runners || {})) {
        if (runner && runner.character && (runner.run_path_units || 0) >= MIN_RUN_UNITS
          && !runner.assist_frames) {
          bump(siteName(runner.character), 'running')
        }
      }

      const side = play.inning_half
      if (!sides.has(side)) sides.set(side, new Map())
      const roster = sides.get(side)
      if (play.batter) onField.add(siteName(play.batter))
      for (const [position, fielder] of Object.entries(play.fielders || {})) {
        if (!fielder || !fielder.character) continue
        const who = siteName(fielder.character)
        onField.add(who)
        roster.set(position, who)
        if (!positionsPlayed.has(who)) positionsPlayed.set(who, new Set())
        positionsPlayed.get(who).add(position)
      }
    }
    // sessionsPlayed is accumulated above, over EVERY session including the
    // excluded ones; counting it again here would double every unexcluded one.
    for (const roster of sides.values()) {
      const names = [...roster.values()]
      if (names.length < 9) continue
      const { net } = teamChemistry(names)
      if (net >= CHEMISTRY_NET_THRESHOLD) chemistry.good += 1
      else if (net <= -CHEMISTRY_NET_THRESHOLD) chemistry.bad += 1
      else chemistry.neutral += 1
    }
  }

  for (const file of fs.readdirSync(TRACKING_DIR).filter((n) => n.endsWith('.pitches.jsonl'))) {
    // Excluded the same way and for the same reason: the pitches in a research
    // game were thrown to a batter aiming at a hazard.
    if (excludedStems.has(file.replace(/\.pitches\.jsonl$/, ''))) continue
    for (const line of fs.readFileSync(path.join(TRACKING_DIR, file), 'utf8').split('\n')) {
      if (!line.trim()) continue
      bump(siteName(JSON.parse(line).pitcher), 'pitching')
    }
  }
  return {
    counts, positionsPlayed, sessionsPlayed, parks, chemistry, sessions: playFiles.length,
    excluded: [...excludedStems].sort(),
  }
}

/**
 * Recorded sessions that have never been derived, and so are in no count here.
 *
 * A capture is a `.bin`; the counts read `.plays.jsonl`, which only
 * `derive_player_metrics.py` writes. Nothing in the recording path runs it, so
 * a session can sit on disk for a day being silently absent from every number
 * below -- which is what happened to bowser_castle-20260904T011909Z: eighteen
 * characters played a full game and the next card still called them the
 * furthest behind.
 */
function underivedSessions() {
  if (!fs.existsSync(TRACKING_DIR)) return []
  const files = fs.readdirSync(TRACKING_DIR)
  const derived = new Set(
    files.filter((n) => n.endsWith('.plays.jsonl'))
      .map((n) => n.replace(/\.plays\.jsonl$/, '')),
  )
  return files
    .filter((n) => n.endsWith('.bin'))
    .map((n) => n.replace(/\.bin$/, ''))
    .filter((stem) => !derived.has(stem))
    .sort()
}

function countsFor(state, name) {
  return state.counts.get(name) || Object.fromEntries(REQUIREMENTS.map((r) => [r.key, 0]))
}

/**
 * How much of the calibration is done, as a share of requirement units met.
 *
 * Every character-metric pair is one unit, plus the park and chemistry
 * exposures. Counting units rather than characters stops a single metric that
 * is nearly finished from reading as though the whole job is.
 */
function progress(state, playable) {
  const rows = REQUIREMENTS.map((requirement) => {
    const met = playable.filter(
      (c) => countsFor(state, c.name)[requirement.key] >= requirement.target,
    ).length
    return { ...requirement, met, total: playable.length }
  })
  const parkMet = STADIUMS.filter(
    (name) => (state.parks.get(parkKey(name)) || 0) >= PARK_TARGET,
  ).length
  const chemistryMet = Math.min(state.chemistry.good, CHEMISTRY_TARGETS.good)
    + Math.min(state.chemistry.bad, CHEMISTRY_TARGETS.bad)
  const chemistryTotal = CHEMISTRY_TARGETS.good + CHEMISTRY_TARGETS.bad
  const met = rows.reduce((sum, r) => sum + r.met, 0) + parkMet + chemistryMet
  const total = rows.reduce((sum, r) => sum + r.total, 0) + STADIUMS.length + chemistryTotal
  return {
    rows,
    parkMet,
    parkTotal: STADIUMS.length,
    chemistryMet,
    chemistryTotal,
    percent: total ? (met / total) * 100 : 100,
    complete: met >= total,
  }
}

// THE GAME'S OWN STADIUM BYTE, NOT THE FILENAME. A session stem carries
// whatever park name the collector used on the day, and those have drifted:
// the 2026-08-26 Wario City session is on disk as "wario_stadium", so counting
// parks by filename prefix reported Wario City as never played and would have
// sent the operator back there forever. The byte is the game's own identity and
// every session header records it. collect_player_tracking.py owns this map.
const STADIUM_BYTE_TO_KEY = {
  0: 'mario_stadium',
  1: 'bowser_castle',
  2: 'wario_city',
  3: 'yoshi_park',
  4: 'peach_ice_garden',
  5: 'dk_jungle',
  6: 'luigis_mansion',
  7: 'daisy_cruiser',
  8: 'bowser_jr_playroom',
}

function parkKey(stadiumName) {
  const key = STADIUM_NAME_TO_KEY[stadiumName]
  if (!key) throw new Error(`No park key for stadium "${stadiumName}".`)
  return key
}

/**
 * Whether a session's measurements may be counted toward calibration.
 *
 * A STADIUM-RESEARCH GAME IS NOT A SAMPLE OF NORMAL PLAY. The operator, on the
 * 2026-09-09 Wario City night session: "we should not be using any of this data
 * for calibration, as i am intentionally missing some balls so they can hit the
 * arrows and manholes." Balls are deliberately not fielded, so every fielding
 * chance, route and reaction in it is drawn from a defence that was told to let
 * the ball go. Counting those toward "primary fielding chances at 20+" does not
 * merely add noise -- it adds a bias in one direction, and it is invisible
 * afterwards because a missed ball looks exactly like a ball nobody could reach.
 *
 * The flag lives in the session header so it travels with the capture and
 * cannot be lost by re-deriving. Absent means countable, so every session
 * already on disk is unaffected.
 */
function sessionIsExcluded(stem) {
  const header = path.join(TRACKING_DIR, `${stem}.json`)
  if (!fs.existsSync(header)) return false
  try {
    const parsed = JSON.parse(fs.readFileSync(header, 'utf8'))
    return parsed.calibration_excluded === true
  } catch {
    return false
  }
}

/** The park a recorded session was played in, from its header. */
function sessionParkKey(stem) {
  const header = path.join(TRACKING_DIR, `${stem}.json`)
  if (fs.existsSync(header)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(header, 'utf8'))
      const byByte = STADIUM_BYTE_TO_KEY[parsed.stadium_byte]
      if (byByte) return byByte
      if (parsed.park) return parsed.park
    } catch {
      // Fall through to the stem below rather than dropping the session.
    }
  }
  return stem.split('-')[0]
}

/**
 * How badly one character still needs a game.
 *
 * The share of each requirement they are still missing, summed. A character
 * short on four metrics outranks one short on a single metric by more than it
 * outranks nothing, which is what puts the genuinely unmeasured characters on
 * the field first.
 */
function need(state, name) {
  const have = countsFor(state, name)
  return REQUIREMENTS.reduce((sum, requirement) => {
    const missing = Math.max(0, requirement.target - have[requirement.key])
    return sum + (missing / requirement.target)
  }, 0)
}

// AT MOST THIS MANY OF ONE FAMILY ON THE FIELD AT ONCE. `need` cannot tell a
// Magikoopa from a Red Magikoopa: colour variants are drafted the same way and
// measured the same way, so they land on identical need values and the ranked
// list selects them as a block. The Bowser Castle cast came out with three
// Magikoopas, two Yoshis, two Dry Bones, two Shy Guys and two Piantas -- 11 of
// 18 slots were a variant of a family that appeared more than once, which is
// what the operator was seeing as "the same characters over and over". They are
// not the same character, but on screen they are the same sprite in a different
// colour, and a game is harder to judge when three fielders look alike.
//
// It is also a chemistry problem: variants of one family have chemistry with
// each other, so stacking three of them contaminates whichever treatment the
// game was chosen to apply.
//
// Deferring the third Magikoopa costs one game -- they are still at the top of
// the list next time -- so this is a cap and not a filter, and it is lifted
// rather than leave a seat empty.
const FAMILY_LIMIT = 2

/** The family a character belongs to; chemistry.js already curates this map. */
function characterFamily(name) {
  return CHARACTER_VARIANTS[name] || name
}

/**
 * The eighteen most-needed characters, no more than two from any one family.
 *
 * Walks the ranked list in order and skips a candidate whose family is already
 * full, then makes a second pass that ignores the cap so the cast is always
 * filled -- a smaller cast would be a worse trade than two lookalikes.
 */
function selectCast(ranked, size = 18) {
  const perFamily = new Map()
  const chosen = []
  for (const row of ranked) {
    if (chosen.length >= size) break
    const family = characterFamily(row.name)
    if ((perFamily.get(family) || 0) >= FAMILY_LIMIT) continue
    perFamily.set(family, (perFamily.get(family) || 0) + 1)
    chosen.push(row.name)
  }
  for (const row of ranked) {
    if (chosen.length >= size) break
    if (!chosen.includes(row.name)) chosen.push(row.name)
  }
  return chosen
}

function seededShuffle(items, seed) {
  const out = [...items]
  let state = seed >>> 0
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0
    const j = state % (i + 1)
    const swap = out[i]
    out[i] = out[j]
    out[j] = swap
  }
  return out
}

function splitTeams(cast, mode, seed) {
  let best = null
  for (let trial = 0; trial < 600; trial += 1) {
    const shuffled = seededShuffle(cast, seed + trial)
    const away = shuffled.slice(0, 9)
    const home = shuffled.slice(9)
    const a = teamChemistry(away)
    const b = teamChemistry(home)
    // Score the WORSE of the two teams. Summing lets one side carry the game,
    // and a treatment only half-applied is not the treatment.
    const score = (team) => (mode === 'neutral' ? -team.links
      : mode === 'good' ? team.net
        : -team.net)
    const value = Math.min(score(a), score(b))
    if (!best || value > best.value) best = { value, away, home, a, b }
  }
  return best
}

// QUALIFYING PRIMARY-FIELDING CHANCES PER NINE-INNING STINT, measured over the
// archive (1,199 chances across 22 sessions). The spread is the whole problem
// with the fielding requirement: the target is 20 chances, and four of the nine
// positions cannot produce them at any rate that matters. A catcher has been
// the primary fielder zero times in 1,801 plays; a pitcher four.
const FIELDING_CHANCES_PER_GAME = {
  centerField: 7.5,
  rightField: 4.8,
  secondBase: 4.4,
  leftField: 4.0,
  shortStop: 2.7,
  thirdBase: 2.0,
  firstBase: 1.8,
  pitcher: 0.1,
  catcher: 0.0,
}

/**
 * Give the positions that produce chances to the characters who need them.
 *
 * This used to hand each character "a position they have not played", and it
 * never did: `positionsPlayed` is keyed by the labels the capture writes (P, C,
 * 1B) and this compared them against POSITIONS (pitcher, catcher, firstBase),
 * so nothing ever matched, every position read as unplayed, and the assignment
 * collapsed to POSITIONS order down the batting order -- pitcher, catcher,
 * first base first. Those are the three worst slots for the metric the whole
 * calibration is short on, handed out first, every game. Wario played seven
 * sessions that way and took four fielding chances; his 184 measured pitches
 * are on a requirement that was already 45/71 done.
 *
 * So positions now go in descending chance yield to whoever is furthest from
 * 20 chances, which leaves pitcher and catcher for the two who need fielding
 * least -- and of those two, the mound goes to whoever is further from 20
 * measured pitches. Ties prefer a character who has not played the position, so
 * variety still happens where it costs nothing.
 */
function assignPositions(team, state) {
  const target = Object.fromEntries(REQUIREMENTS.map((r) => [r.key, r.target]))
  const shortOn = (name, key) => Math.max(0, target[key] - countsFor(state, name)[key])
  const hasPlayed = (name, position) =>
    (state.positionsPlayed.get(name) || new Set()).has(POSITION_LABEL[position])

  const remaining = new Set(team)
  const assigned = new Map()
  const byYield = [...POSITIONS]
    .sort((a, b) => FIELDING_CHANCES_PER_GAME[b] - FIELDING_CHANCES_PER_GAME[a])
  for (const position of byYield) {
    // The mound is the one slot where the fielding shortfall is not the point.
    const key = position === 'pitcher' ? 'pitching' : 'fielding'
    const [pick] = [...remaining].sort((a, b) =>
      shortOn(b, key) - shortOn(a, key)
      || Number(hasPlayed(a, position)) - Number(hasPlayed(b, position))
      || a.localeCompare(b))
    assigned.set(pick, position)
    remaining.delete(pick)
  }
  // Batting order is the order the cast came in; only the gloves move.
  return team.map((name) => ({ name, position: assigned.get(name) }))
}

/** Rotate only teammates still short of the pitching target onto the mound. */
function pitcherRotation(entries, state) {
  const starter = entries.find((entry) => entry.position === 'pitcher')
  const target = REQUIREMENTS.find((entry) => entry.key === 'pitching').target
  const relievers = entries
    .filter((entry) => entry !== starter)
    // Once their pitching sample is complete, keep their assigned glove:
    // rotating a short-on-fielding CF onto the mound sacrifices useful chances.
    .filter((entry) => countsFor(state, entry.name).pitching < target)
    .sort((a, b) => countsFor(state, a.name).pitching - countsFor(state, b.name).pitching
      || a.name.localeCompare(b.name))
    .slice(0, 2)
  return [starter, ...relievers].filter(Boolean).map((entry) => entry.name)
}

function buildTeam(label, entries, characterByName) {
  const slots = entries.map((entry, battingSlot) => {
    const character = characterByName.get(entry.name)
    const charIndex = siteNameToCharIndex(entry.name)
    if (charIndex === null || charIndex === undefined) {
      throw new Error(`${entry.name} has no MSS roster index.`)
    }
    if (charIndex > LAST_WRITABLE_CHAR_INDEX) {
      throw new Error(`${entry.name} is at charList index ${charIndex}, an "Unused" slot.`)
    }
    return {
      battingSlot,
      fieldingSlot: POSITIONS.indexOf(entry.position),
      positionId: entry.position,
      charIndex,
      siteName: entry.name,
      characterId: character ? character.id : null,
      miiColor: null,
    }
  })
  const captainSlot = slots
    .map((slot) => CAPTAIN_CHAR_INDEXES.indexOf(slot.charIndex))
    .find((index) => index !== -1)
  return {
    label,
    playerId: null,
    playerName: `Calibration ${label}`,
    slots,
    captainSlot: captainSlot === undefined ? 0 : captainSlot,
  }
}

const POSITION_LABEL = {
  pitcher: 'P',
  catcher: 'C',
  firstBase: '1B',
  secondBase: '2B',
  thirdBase: '3B',
  shortStop: 'SS',
  leftField: 'LF',
  centerField: 'CF',
  rightField: 'RF',
}

function bar(fraction, width = 24) {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width)
  return `${'#'.repeat(filled)}${'.'.repeat(width - filled)}`
}

function reportStatus(state, playable, done) {
  console.log(`CALIBRATION  ${done.percent.toFixed(0)}% complete`
    + `   (${state.sessions} sessions recorded)`)
  console.log()
  for (const row of done.rows) {
    const short = row.total - row.met
    console.log(`  ${row.label.padEnd(26)} ${bar(row.met / row.total)}`
      + ` ${String(row.met).padStart(3)}/${row.total} characters at ${row.target}+`
      + (short ? `   ${short} short` : '   done'))
  }
  console.log(`  ${'parks with 2+ sessions'.padEnd(26)} ${bar(done.parkMet / done.parkTotal)}`
    + ` ${String(done.parkMet).padStart(3)}/${done.parkTotal}`
    + (done.parkMet < done.parkTotal ? '   short' : '   done'))
  console.log(`  ${'chemistry exposure'.padEnd(26)} ${bar(done.chemistryMet / done.chemistryTotal)}`
    + ` good ${state.chemistry.good}/${CHEMISTRY_TARGETS.good},`
    + ` bad ${state.chemistry.bad}/${CHEMISTRY_TARGETS.bad}`)

  // Name the characters actually holding the calibration back, or the operator
  // has a percentage and no idea what to do about it.
  const worst = playable
    .map((c) => ({ name: c.name, need: need(state, c.name) }))
    .filter((row) => row.need > 0)
    .sort((a, b) => b.need - a.need)
    .slice(0, 6)
  if (worst.length) {
    console.log(`\n  furthest behind: ${worst.map((row) => row.name).join(', ')}`)
  }
}

/** The park with the fewest recorded sessions; ties go in menu order. */
function chooseStadium(state) {
  return [...STADIUMS]
    .map((name) => ({ name, sessions: state.parks.get(parkKey(name)) || 0 }))
    .sort((a, b) => a.sessions - b.sessions
      || STADIUMS.indexOf(a.name) - STADIUMS.indexOf(b.name))[0]
}

/** Whichever chemistry exposure is furthest from its target. */
function chooseMode(state) {
  const goodGap = CHEMISTRY_TARGETS.good - state.chemistry.good
  const badGap = CHEMISTRY_TARGETS.bad - state.chemistry.bad
  if (goodGap <= 0 && badGap <= 0) return 'neutral'
  return badGap / CHEMISTRY_TARGETS.bad > goodGap / CHEMISTRY_TARGETS.good ? 'bad' : 'good'
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const env = { ...loadEnv(path.resolve('.env')), ...process.env }
  const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY)
  const { data: characters, error } = await supabase
    .from('characters').select('id,name')
  if (error) throw new Error(`characters: ${error.message}`)

  const playable = characters
    .filter((c) => !EXCLUDED.has(c.name))
    .filter((c) => {
      const index = siteNameToCharIndex(c.name)
      return index !== null && index !== undefined && index <= LAST_WRITABLE_CHAR_INDEX
    })
  const characterByName = new Map(playable.map((c) => [c.name, c]))

  // Resolved against EVERY character, not just the playable ones: Mii is
  // deliberately excluded from a calibration cast, and warning that a Mii on
  // the field cannot be named would be crying wolf about a rule this script
  // wrote itself. Only a name that matches no character at all is a gap.
  const resolveSiteName = siteNameResolver(characters)
  const state = readArchive(resolveSiteName)
  if (resolveSiteName.unmatched.size) {
    console.log(`
  WARNING  ${resolveSiteName.unmatched.size} capture name(s) match no site`
      + ` character and are counted separately:`)
    console.log(`           ${[...resolveSiteName.unmatched].join(', ')}`)
    console.log('           Add them to CHARACTER_NAME_ALIASES in src/utils/characterNames.js.')
  }
  const underived = underivedSessions()
  if (underived.length) {
    console.log(`
  WARNING  ${underived.length} recorded session(s) are in none of the counts`
      + ` below, because they have not been derived:`)
    for (const stem of underived) console.log(`           ${stem}`)
    console.log('           python scripts/calibrate_player_tracking.py'
      + ' data/player_tracking/<session>')
    console.log('           python scripts/derive_player_metrics.py'
      + ' data/player_tracking/<session>')
  }

  const done = progress(state, playable)
  reportStatus(state, playable, done)
  if (state.excluded?.length) {
    console.log(`\n  ${state.excluded.length} session(s) excluded from these counts `
      + '(stadium research: balls deliberately not fielded):')
    for (const stem of state.excluded) console.log(`    ${stem}`)
  }

  if (done.complete && !args.stadium) {
    console.log('\nCALIBRATION COMPLETE. Every requirement is met; no further games are needed.')
    console.log('  The stadium-event gate is still shut. For a research game there, name')
    console.log('  the park and its variant:  --stadium "Wario City" --night')
    return
  }
  if (args.statusOnly) return
  if (done.complete) {
    console.log('\nCALIBRATION COMPLETE -- this game is for the stadium-event gate, not for coverage.')
    console.log('  Every `need` is zero, so the cast below is the eighteen who have played')
    console.log('  FEWEST, not the eighteen who are least measured.')
  }

  // WHY THE TIE-BREAK IS NOT THE ALPHABET. `need` is a sum of five fractions
  // over coarse targets, so it lands on the same handful of values constantly:
  // at 22 sessions, 57 of the 71 playable characters share an exact need with
  // someone else and 39 sit within 0.25 of the eighteenth-place cut. Breaking
  // those ties with localeCompare picked the same order on every run, which is
  // how Green Noki sat out at 2 sessions played while Yellow Pianta was
  // selected again at 6 -- the operator's "same faces every game", arriving by
  // a different route than the name bug that preceded it.
  //
  // So an exact tie now goes to whoever has been on the field least. It does
  // not touch what `need` measures; it only decides who goes first when the
  // measurement cannot tell two characters apart.
  const played = (name) => state.sessionsPlayed.get(name) || 0
  const ranked = playable
    .map((c) => ({ name: c.name, need: need(state, c.name), played: played(c.name) }))
    .sort((a, b) => b.need - a.need || a.played - b.played || a.name.localeCompare(b.name))
  // Forced names take their seats first and the family limit never drops them;
  // the ranked pick fills whatever seats remain.
  const included = [...new Set(args.include.map((name) => {
    const site = resolveSiteName(name)
    if (!characterByName.has(site)) {
      throw new Error(`--include: "${name}" is not a playable character.`)
    }
    return site
  }))]
  const cast = [...included, ...selectCast(
    ranked.filter((row) => !included.includes(row.name)), 18 - included.length)]
  if (cast.length < 18) throw new Error(`Only ${cast.length} playable characters available.`)
  if (included.length) console.log(`\n  forced into the cast: ${included.join(', ')}`)

  const stadium = args.stadium
    ? { name: args.stadium, sessions: state.parks.get(parkKey(args.stadium)) || 0 }
    : chooseStadium(state)
  const mode = chooseMode(state)
  const split = splitTeams(cast, mode, state.sessions * 7919 + 13)
  const awayEntries = assignPositions(split.away, state)
  const homeEntries = assignPositions(split.home, state)
  const away = buildTeam('Away', awayEntries, characterByName)
  const home = buildTeam('Home', homeEntries, characterByName)
  const pitchers = {
    away: pitcherRotation(awayEntries, state),
    home: pitcherRotation(homeEntries, state),
  }
  // Day unless the park only exists at night. Bowser Castle and Luigi's
  // Mansion are night-only, and a night-only park written as day loads
  // without its hazards -- see STADIUM_FIXED_TIME_OF_DAY in mss_roster.mjs.
  const isNight = stadiumTimeOfDay(stadium.name, args.night ?? false)
  if (args.night !== null && isNight !== args.night) {
    // A park that exists at only one time of day ignores the request, and a
    // session recorded in the variant a park does not have loads with none of
    // the hazards it was played for -- see STADIUM_FIXED_TIME_OF_DAY.
    console.log(`\n  NOTE: ${stadium.name} only exists at ${isNight ? 'night' : 'day'}; `
      + `the --${args.night ? 'night' : 'day'} request does not apply to it.`)
  }
  const stadiumTest = stadiumTestCard(stadium.name, isNight)

  console.log(`\nNEXT GAME   ${stadium.name}`
    + `   (${stadium.sessions} session${stadium.sessions === 1 ? '' : 's'} recorded there)`
    + `   chemistry: ${mode}`)
  console.log(`            away net ${split.a.net} / home net ${split.b.net}`
    + `   links ${split.a.links}/${split.b.links}`)
  console.log()
  console.log(`  ${'AWAY'.padEnd(34)}HOME`)
  for (let index = 0; index < 9; index += 1) {
    const a = away.slots[index]
    const b = home.slots[index]
    const left = `${index + 1}. ${POSITION_LABEL[a.positionId].padEnd(3)} ${a.siteName}`
    const right = `${index + 1}. ${POSITION_LABEL[b.positionId].padEnd(3)} ${b.siteName}`
    console.log(`  ${left.padEnd(34)}${right}`)
  }
  console.log(`\n  pitchers (change every 3 innings only where a rotation is listed):`)
  console.log(`    away  ${pitchers.away.join('  ->  ')}`)
  console.log(`    home  ${pitchers.home.join('  ->  ')}`)
  console.log(`\n  stadium test card (${stadiumTest.variant}; aim for ${stadiumTest.repeatTarget} of each):`)
  for (const objective of stadiumTest.objectives) {
    console.log(`    ${objective.id} [${objective.annotationCategory}]: ${objective.instruction}`)
  }
  console.log(`    note format: ${stadiumTest.annotationNoteFormat}`)

  const payload = {
    generatedAt: new Date().toISOString(),
    game: {
      id: null,
      table: 'calibration',
      sourceId: null,
      stadium: stadium.name,
      stadiumIndex: STADIUMS.indexOf(stadium.name),
      isNight,
      homeAwaySwapped: false,
      calibration: {
        chemistryMode: mode,
        pitcherRotation: pitchers,
        percentCompleteBefore: Number(done.percent.toFixed(1)),
        stadiumTest,
      },
    },
    miiCount: null,
    // [innings, stars, items, mercy]. Items off: nothing models them and they
    // inject fielder freezes no field in the capture explains. Stars on: they
    // ARE modelled, and the derivation already separates them.
    rules: [9, 1, 0, 0],
    away,
    home,
  }
  fs.mkdirSync(path.dirname(args.out), { recursive: true })
  fs.writeFileSync(args.out, `${JSON.stringify(payload, null, 2)}\n`)

  const relative = path.relative(process.cwd(), args.out).split(path.sep).join('/')
  console.log(`\n  written to ${relative}`)
  console.log('\n  run:  npm run tracker:preview -- --calibration-excluded')
  console.log(`        python scripts/mss_autoteam.py --lineup ${relative} --stage all --wait-for-live`)
  console.log('\n  then run this again for the next one.')
}

main().catch((error) => {
  console.error(`next_calibration_game: ${error.message}`)
  process.exit(1)
})
