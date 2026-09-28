// The evidence-expansion session plan: lineup, randomized schedule, annotation
// template and printable cards, all from one recorded seed.
//
//   node scripts/plan_evidence_session.mjs            # writes the four files
//   node scripts/plan_evidence_session.mjs --seed 7   # a different shuffle
//
// THE PLAN IS WRITTEN BEFORE ANY OF THE MEMORY IS LOOKED AT, and it is the
// label only where the operator confirms it happened. Every card is an
// intention; the template beside it is where deviations go, and a card is gold
// only once `confirmed_no_deviation` is true.
//
// WHY THESE EIGHTEEN. In the 11-game batting cohort every one of 54 batter
// characters belongs to exactly one of six players, so character and player
// cannot be separated (docs/batting-uva-feasibility-2026-09-28.md). Every
// character below is one ANOTHER player already owns in that cohort; Jason
// playing it gives it a second player. All five other owners are represented,
// and each team carries its own captain plus borrowed captains, whose star
// costs the non-main-captain price -- a spend no capture has seen yet.

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { getChemistry, chemistryNamesMatch } from '../src/data/chemistry.js'
import { CAPTAIN_CHAR_INDEXES, POSITIONS, siteNameToCharIndex } from './mss_roster.mjs'

const DEFAULT_SEED = 20260928
const OUT = {
  lineup: 'data/calibration/evidence-expansion-lineup.json',
  schedule: 'data/calibration/evidence-expansion-schedule-v1.json',
  template: 'data/calibration/evidence-expansion-annotations-template-v1.json',
  cards: 'docs/evidence-session-cards.md',
}

// [site name, position, archive owner (batting-uva-evaluation-v1 cohort)]
const TEAMS = {
  mario: {
    label: 'Team Mario',
    captain: 'Mario',
    order: [
      ['Yoshi', 'centerField', 'Aidan'],
      ['Red Toad', 'rightField', 'May'],
      ['Luigi', 'secondBase', 'May'],
      ['King K. Rool', 'catcher', 'May'],
      ['Mario', 'pitcher', 'Aidan'],
      ['Yellow Pianta', 'leftField', 'May'],
      ['Blue Pianta', 'firstBase', 'Nick'],
      ['Boomerang Bro', 'thirdBase', 'Justin'],
      ['Green Paratroopa', 'shortStop', 'Aidan'],
    ],
  },
  peach: {
    label: 'Team Peach',
    captain: 'Peach',
    order: [
      ['Toadette', 'centerField', 'Nick'],
      ['Wiggler', 'rightField', 'Donovan'],
      ['Daisy', 'shortStop', 'Justin'],
      ['Bowser', 'catcher', 'Nick'],
      ['Funky Kong', 'firstBase', 'May'],
      ['Wario', 'thirdBase', 'Nick'],
      ['Birdo', 'secondBase', 'Justin'],
      ['Hammer Bro', 'leftField', 'Aidan'],
      ['Peach', 'pitcher', 'Donovan'],
    ],
  },
}

const INNINGS = 9
const FIRST_STAR_PA = 18

// One card per plate appearance, in PA order. More cards than a 9-inning game
// usually needs; the operator simply stops using them when the game ends.
const BATTING = {
  take: [10, 'Do not offer at any pitch this PA.'],
  slap: [12, 'Swing every pitch with NO charge.'],
  charge_short: [10, 'Charge, then release quickly (well under half the meter).'],
  charge_medium: [10, 'Charge to about a full meter (~1 s), then swing.'],
  charge_long: [10, 'Hold the charge 2 s or more, then swing.'],
  charge_early: [8, 'Charge, and deliberately swing EARLY for the pitch.'],
  charge_late: [8, 'Charge, and deliberately swing LATE for the pitch.'],
  bunt: [8, 'Bunt every pitch.'],
  bunt_pull_back: [6, 'Square to bunt, then pull back (do not offer).'],
  star_swing: [8, 'Star swing if the meter allows; otherwise slap and annotate star_unavailable.'],
}
const PITCHING = {
  normal: [16, 'Plain pitch, no charge.'],
  changeup: [14, 'Changeup, no charge.'],
  charge_short: [12, 'Charge briefly, then throw.'],
  charge_medium: [12, 'Charge about half-way, then throw.'],
  charge_long: [12, 'Charge as long as possible, then throw.'],
  release_early: [8, 'Throw the moment you can (fast release).'],
  release_late: [8, 'Wait as long as you can before throwing (slow release).'],
  star: [8, 'Star pitch if the meter allows; otherwise plain and annotate star_unavailable.'],
}
// Screen-relative, as the pitch audit's operator used it: "left" is the third
// base side and reads as negative plate_x in the capture.
const AIM = {
  middle: [24, 'Aim down the middle.'],
  left_edge: [22, 'Aim at the LEFT edge of the zone (3B side on screen).'],
  right_edge: [22, 'Aim at the RIGHT edge of the zone (1B side on screen).'],
  outside_left: [11, 'Aim clearly OUTSIDE, left.'],
  outside_right: [11, 'Aim clearly OUTSIDE, right.'],
}
// Per half-inning, for the FIELDING side. Each team gets each condition once.
const FIELDING = {
  control_no_special: 'Field normally. No dive, jump, Buddy action or manual selection change.',
  dive_every_chance: 'Dive at every ball you can reach.',
  jump_every_chance: 'Jump at every ball you can reach (wall balls and liners).',
  miss_dive: 'On every ball in play, press DIVE once with a fielder nowhere near the ball.',
  miss_jump: 'On every ball in play, press JUMP once with a fielder nowhere near the ball.',
  buddy_attack: 'Buddy Attack whenever possible, including ones that will miss.',
  buddy_jump: 'Buddy Jump on every high ball near the wall, even hopeless ones.',
  buddy_throw: 'Attempt a Buddy Throw on every throw where one is offered.',
  selection_change: 'Switch the controlled fielder at least twice on every ball in play.',
}
// Per half-inning, for the BATTING side's runners.
const RUNNING = {
  no_shake: 'Do not shake at all while runners move.',
  short_shake: 'One short shake burst (under 1 s) at contact, then stop.',
  sustained_shake: 'Shake continuously from contact until every runner stops.',
  delayed_shake: 'Wait ~1 s after contact, then shake until runners stop.',
}

function mulberry32(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle(items, random) {
  const out = [...items]
  for (let index = out.length - 1; index > 0; index -= 1) {
    const pick = Math.floor(random() * (index + 1))
    ;[out[index], out[pick]] = [out[pick], out[index]]
  }
  return out
}

function deck(spec, random) {
  return shuffle(Object.entries(spec).flatMap(([name, [count]]) => Array(count).fill(name)), random)
}

export function buildPlan(seed = DEFAULT_SEED) {
  const random = mulberry32(seed)
  const batting = deck(BATTING, random)
  const pitching = deck(PITCHING, random)
  const aims = deck(AIM, random)
  // Both meters start the game empty and fill in discrete awards, so a star
  // card in the first innings is a card that cannot be played. Move them later.
  for (const [cards, star] of [[batting, 'star_swing'], [pitching, 'star']]) {
    for (let index = 0; index < FIRST_STAR_PA - 1; index += 1) {
      if (cards[index] !== star) continue
      const later = cards.map((mode, other) => (other >= FIRST_STAR_PA - 1 && mode !== star ? other : -1))
        .filter((other) => other !== -1)
      const swap = later[Math.floor(random() * later.length)]
      ;[cards[index], cards[swap]] = [cards[swap], cards[index]]
    }
  }
  // A star swing and a star pitch on one PA would spend both meters at once
  // and confound which spend was which. Swap the pitch card forward.
  for (let index = 0; index < batting.length; index += 1) {
    if (batting[index] === 'star_swing' && pitching[index] === 'star') {
      const swap = pitching.findIndex((mode, other) => other > index && mode !== 'star'
        && batting[other] !== 'star_swing')
      if (swap !== -1) [pitching[index], pitching[swap]] = [pitching[swap], pitching[index]]
    }
  }
  const cards = batting.map((bat, index) => ({
    pa: index + 1,
    batter_action: bat,
    pitch_action: pitching[index],
    pitch_aim: aims[index],
  }))

  // Top halves: Team Peach fields (Team Mario is the away side batting first,
  // as the lineup file loads it). The capture decides sides from memory, so
  // the halves are named by the TEAM that fields, never by away/home.
  const fieldingOrder = {
    peach: shuffle(Object.keys(FIELDING), random),
    mario: shuffle(Object.keys(FIELDING), random),
  }
  const runningDeck = (count) => shuffle(Array.from({ length: count },
    (_, index) => Object.keys(RUNNING)[index % 4]), random)
  const runningOrder = { mario: runningDeck(INNINGS), peach: runningDeck(INNINGS) }
  const halves = []
  for (let inning = 1; inning <= INNINGS; inning += 1) {
    for (const half of ['top', 'bottom']) {
      const fielding = half === 'top' ? 'peach' : 'mario'
      const batting = half === 'top' ? 'mario' : 'peach'
      halves.push({
        inning, half,
        batting_team: TEAMS[batting].label,
        fielding_team: TEAMS[fielding].label,
        fielding_condition: fieldingOrder[fielding][inning - 1],
        running_condition: runningOrder[batting][inning - 1],
      })
    }
  }
  return { cards, halves }
}

function chemistryPairs(names) {
  const pairs = []
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      const a = names[i]
      const b = names[j]
      const good = getChemistry(a).good.some((n) => chemistryNamesMatch(n, b))
        || getChemistry(b).good.some((n) => chemistryNamesMatch(n, a))
      if (good) pairs.push([a, b])
    }
  }
  return pairs
}

function lineupTeam(team) {
  const slots = team.order.map(([name, position], battingSlot) => {
    const charIndex = siteNameToCharIndex(name)
    if (charIndex === null || charIndex === undefined) throw new Error(`${name} has no MSS roster index`)
    return {
      battingSlot, fieldingSlot: POSITIONS.indexOf(position), positionId: position,
      charIndex, siteName: name, characterId: null, miiColor: null,
    }
  })
  const captainIndex = siteNameToCharIndex(team.captain)
  return {
    label: team.label, playerId: null, playerName: 'Jason', slots,
    captainSlot: CAPTAIN_CHAR_INDEXES.indexOf(captainIndex),
  }
}

function describe(spec) {
  return Object.fromEntries(Object.entries(spec).map(([key, value]) =>
    [key, Array.isArray(value) ? { planned_count: value[0], instruction: value[1] } : { instruction: value }]))
}

function renderCards(plan, seed) {
  const lines = [
    '# Evidence session cards',
    '',
    `Generated by \`node scripts/plan_evidence_session.mjs\` (seed ${seed}). One row per plate`,
    'appearance, in order -- the console PA number IS the card number. Apply the',
    'batting and pitching instruction to EVERY pitch of that PA. If you do anything',
    'else, annotate the PA (category `input_mode`) with the format on the checklist.',
    '',
    '| PA | Batter | Pitcher | Aim |',
    '|---:|---|---|---|',
    ...plan.cards.map((card) => `| ${card.pa} | ${card.batter_action} | ${card.pitch_action} | ${card.pitch_aim} |`),
    '',
    '## Half-inning conditions',
    '',
    '| Inning | Half | Fielding team does | Batting team runners |',
    '|---:|---|---|---|',
    ...plan.halves.map((half) => `| ${half.inning} | ${half.half} | ${half.fielding_team}: ${half.fielding_condition} | ${half.batting_team}: ${half.running_condition} |`),
    '',
    '## What each instruction means',
    '',
    ...[['Batter', BATTING], ['Pitcher', PITCHING], ['Aim', AIM], ['Fielding', FIELDING], ['Running', RUNNING]]
      .flatMap(([title, spec]) => [`**${title}**`, '',
        ...Object.entries(spec).map(([key, value]) => `- \`${key}\` -- ${Array.isArray(value) ? value[1] : value}`), '']),
  ]
  return `${lines.join('\n')}\n`
}

function main() {
  const seedIndex = process.argv.indexOf('--seed')
  const seed = seedIndex === -1 ? DEFAULT_SEED : Number(process.argv[seedIndex + 1])
  const plan = buildPlan(seed)
  const generatedAt = new Date().toISOString()
  const rosters = Object.fromEntries(Object.entries(TEAMS).map(([key, team]) => [key, {
    label: team.label, captain: team.captain,
    players: team.order.map(([name, position, owner]) => ({ name, position, archive_owner: owner })),
    chemistry_pairs: chemistryPairs(team.order.map(([name]) => name)),
    borrowed_captains: team.order.map(([name]) => name)
      .filter((name) => name !== team.captain
        && CAPTAIN_CHAR_INDEXES.includes(siteNameToCharIndex(name))),
  }]))

  const schedule = {
    schema: 'sluggers-evidence-schedule', version: 1, seed, generated_at: generatedAt,
    stadium: 'Mario Stadium', is_night: false, innings: INNINGS,
    stadium_reason: 'No stadium hazards, so every fielding and running event is an input or a character, not a gimmick. Hazard capture is enabled regardless; hazard examples are not a goal of this session.',
    labelling_unit: 'plate_appearance for batting/pitching cards; half_inning for fielding/running conditions',
    gold_label_rule: 'A planned action is the gold label ONLY where the operator confirms no deviation. Deviations are recorded separately and override the plan; unsure is its own value.',
    annotation: {
      console_category: 'input_mode',
      note_format: 'plan=PA<n>; field=<batter|pitch|aim|fielding|running>; actual=<value|unsure>; pitch=<n if only one pitch of the PA differed, else omit>; reason=<text>',
      examples: [
        'plan=PA14; field=batter; actual=slap; pitch=2; reason=let go of the charge too early',
        'plan=PA22; field=pitch; actual=star_unavailable; reason=meter empty',
        'plan=PA30; field=fielding; actual=miss_dive_not_pressed; reason=ball was caught too fast',
      ],
    },
    rosters,
    batter_actions: describe(BATTING),
    pitch_actions: describe(PITCHING),
    pitch_aims: describe(AIM),
    fielding_conditions: describe(FIELDING),
    running_conditions: describe(RUNNING),
    cards: plan.cards,
    halves: plan.halves,
    targets_if_game_ends_early: 'Cards are shuffled across the whole game, so any prefix of the game samples every action roughly in proportion.',
  }

  const template = {
    schema: 'sluggers-evidence-annotations', version: 1, schedule_seed: seed,
    instructions: 'Fill after the game from the console annotations and your own notes. Leave actual null where the plan was followed; set confirmed_no_deviation true only for PAs/halves you are sure of. unsure is a valid value.',
    plate_appearances: plan.cards.map((card) => ({
      pa: card.pa,
      planned: { batter_action: card.batter_action, pitch_action: card.pitch_action, pitch_aim: card.pitch_aim },
      actual: { batter_action: null, pitch_action: null, pitch_aim: null },
      pitch_level_deviations: [],
      confirmed_no_deviation: null,
      notes: '',
    })),
    half_innings: plan.halves.map((half) => ({
      inning: half.inning, half: half.half,
      planned: { fielding_condition: half.fielding_condition, running_condition: half.running_condition },
      actual: { fielding_condition: null, running_condition: null },
      events: [],
      confirmed_no_deviation: null,
      notes: '',
    })),
    session_deviations: [],
  }

  const lineup = {
    generatedAt,
    game: {
      id: null, table: 'calibration', sourceId: null, stadium: 'Mario Stadium',
      stadiumIndex: 0, isNight: false, homeAwaySwapped: false,
      calibration: {
        evidenceTest: {
          schemaVersion: 1,
          purpose: 'comprehensive_evidence_expansion',
          schedule: OUT.schedule,
          cards: OUT.cards,
          setupCommand: `python scripts/mss_autoteam.py --lineup ${OUT.lineup}`,
          note: 'Sides in this file are only what autoteam loads. The capture resolves which port drives which team from game memory, never from this file.',
        },
      },
    },
    miiCount: 29,
    // innings, stars, items, mercy -- the byte order mss_autoteam writes.
    rules: [INNINGS, 0, 0, 0],
    away: lineupTeam(TEAMS.mario),
    home: lineupTeam(TEAMS.peach),
  }

  for (const [key, payload] of [['lineup', lineup], ['schedule', schedule], ['template', template]]) {
    fs.writeFileSync(path.resolve(OUT[key]), `${JSON.stringify(payload, null, 2)}\n`)
  }
  fs.writeFileSync(path.resolve(OUT.cards), renderCards(plan, seed))
  const counts = (field) => plan.cards.reduce((acc, card) => ({ ...acc, [card[field]]: (acc[card[field]] || 0) + 1 }), {})
  console.log(JSON.stringify({ seed, cards: plan.cards.length, batter: counts('batter_action'),
    pitch: counts('pitch_action'), files: OUT, chemistry: Object.fromEntries(
      Object.entries(rosters).map(([key, team]) => [key, team.chemistry_pairs])),
    borrowed_captains: Object.fromEntries(Object.entries(rosters).map(([k, t]) => [k, t.borrowed_captains])) }, null, 2))
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`
  || process.argv[1]?.endsWith('plan_evidence_session.mjs')) {
  main()
}
