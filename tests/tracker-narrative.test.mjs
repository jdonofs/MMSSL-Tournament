import test from 'node:test'
import assert from 'node:assert/strict'

import { buildTrackerNarrative } from '../scripts/tracker_narrative.mjs'
import {
  FIELDING_ABILITY_ACTIVATION,
  fieldingAbilityFor,
} from '../scripts/tracker_abilities.mjs'
import {
  fieldingEvent,
  firstTouch,
  join,
  landing,
  plateAppearance,
  pitchSequence,
  possessionEvent,
  runnerAssignment,
  throwRecord,
  trackingPlay,
} from './helpers/trackerFixtures.mjs'

// The narrative is the thing an operator reads instead of the numbers, so what
// is tested here is the SENTENCES -- not that a field was copied, but that the
// English says the same thing the data does, and stops saying it the moment
// the data stops supporting it.

const text = (narrative) => narrative.sentences.join(' ')
const clauseFor = (narrative, category) => narrative.clauses.find((clause) => clause.category === category)

test('a called strikeout says it was called, a swinging one says it was swinging', () => {
  const looking = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'K', strikeout_type: 'KL', pitches: pitchSequence(['looking', 'looking', 'looking']) }),
  })
  assert.match(text(looking), /Luigi struck out looking\./)

  const swinging = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'K', strikeout_type: 'KS', pitches: pitchSequence(['swinging_miss', 'looking', 'swinging_miss']) }),
  })
  assert.match(text(swinging), /Luigi struck out swinging\./)

  // A strikeout whose type the tracker never resolved must not claim one.
  const unknown = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'K', strikeout_type: null, pitches: pitchSequence(['strike_unknown', 'strike_unknown', 'strike_unknown']) }),
  })
  assert.match(text(unknown), /Luigi struck out\./)
  assert.doesNotMatch(text(unknown), /looking|swinging/)
})

test('a walk and a hit by pitch are described as themselves, with no batted ball', () => {
  const walk = buildTrackerNarrative({ atBat: plateAppearance({ result: 'BB' }) })
  assert.match(text(walk), /Luigi walked\./)
  assert.doesNotMatch(text(walk), /hit a/)

  const hbp = buildTrackerNarrative({ atBat: plateAppearance({ result: 'HBP' }) })
  assert.match(text(hbp), /Luigi was hit by a pitch\./)
})

test('a home run and an ordinary hit both name trajectory and direction', () => {
  const homer = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'HR', trajectory: 'F', hit_distance_ft: 402, hit_angle_deg: -20 }),
  })
  assert.match(text(homer), /Luigi hit a deep fly ball toward left-center\./)
  assert.match(text(homer), /scored as a home run/)

  const single = buildTrackerNarrative({
    atBat: plateAppearance({ result: '1B', trajectory: 'G', hit_angle_deg: -18 }),
  })
  assert.match(text(single), /Luigi hit a ground ball toward shortstop\./)
  assert.match(text(single), /scored as a single/)
})

test('ground, fly and line outs keep their own trajectory nouns', () => {
  for (const [result, trajectory, noun] of [['GO', 'G', 'ground ball'], ['FO', 'F', 'fly ball'], ['LO', 'L', 'line drive']]) {
    const narrative = buildTrackerNarrative({
      atBat: plateAppearance({ result, trajectory, hit_angle_deg: 0 }),
    })
    assert.match(text(narrative), new RegExp(`hit a ${noun}`), `${result} should read as a ${noun}`)
  }
})

test('an unclassified batted ball says so rather than reading like a description', () => {
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: '1B', trajectory: null, hit_angle_deg: 30 }),
  })
  assert.match(text(narrative), /ball the tracker did not classify/)
})

test("a fielder's choice and a double play are named as scored", () => {
  const fc = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'FC', trajectory: 'G', fielder_choice_out: true, outs_on_play: 1, hit_angle_deg: 10 }),
  })
  assert.match(text(fc), /scored as a fielder's choice/)

  const dp = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'DP', trajectory: 'G', outs_on_play: 2, hit_angle_deg: 10 }),
  })
  assert.match(text(dp), /scored as a double play, 2 outs on the play/)
})

test('an ordinary catch is described as securing the ball before it landed', () => {
  const play = trackingPlay({
    batted_ball_class: 'fair_caught',
    caught_in_flight: true,
    first_touch: firstTouch(),
    fielding_events: [possessionEvent({ by: 'CF', character: 'Birdo', ball_height_units: 1.1 })],
    primary_fielder: 'CF',
    primary_fielder_reason: 'catch',
  })
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'FO', trajectory: 'F', hit_angle_deg: 5 }),
    play,
    join: join('joined'),
  })
  assert.match(text(narrative), /Birdo \(CF\) secured the ball before it landed\./)
})

test('a fielding attempt that made contact but did not secure keeps the two facts apart', () => {
  const play = trackingPlay({
    fielding_events: [fieldingEvent({
      ball_contact: 'confirmed', secured: false, by: '2B', character: 'Brown Kritter',
      confidence: 'high', contact_source: 'last_contact_fielder', action_code: 3,
    })],
  })
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: '1B', trajectory: 'G', hit_angle_deg: 12 }),
    play,
    join: join('joined'),
  })
  assert.match(text(narrative), /Brown Kritter \(2B\) contacted the ball but failed to secure it\./)
  // The physical boot is never promoted to an official scoring error.
  assert.match(text(narrative), /No official error determination is available/)
  assert.doesNotMatch(text(narrative), /error is charged/)
})

test('a clean miss says an attempt was made and contact was not', () => {
  const play = trackingPlay({
    fielding_events: [fieldingEvent({
      ball_contact: 'missed', by: 'SS', character: 'Waluigi',
      confidence: 'high', contact_source: 'action_without_contact_actor', action_code: 3,
    })],
  })
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: '1B', trajectory: 'G', hit_angle_deg: -18 }),
    play,
    join: join('joined'),
  })
  assert.match(text(narrative), /Waluigi \(SS\) attempted to field the ball but did not make contact\./)
})

test('an unknown contact is reported as unknown, not as a miss or a boot', () => {
  const play = trackingPlay({
    fielding_events: [fieldingEvent({
      ball_contact: 'unknown', by: '3B', character: 'Shy Guy',
      confidence: 'low', contact_source: 'no_contact_actor', action_code: 2,
    })],
  })
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: '1B', trajectory: 'G', hit_angle_deg: -35 }),
    play,
    join: join('joined'),
  })
  assert.match(text(narrative), /detected an attempt by Shy Guy \(3B\) but could not determine whether contact occurred/)
  const clause = narrative.clauses.find((entry) => entry.category === 'attempt')
  assert.equal(clause.status, 'unknown')
})

test('a bobble recovered by the same fielder reads as two separate facts', () => {
  const play = trackingPlay({
    fielding_events: [
      fieldingEvent({ ball_contact: 'confirmed', by: 'RF', character: 'Birdo', t: 1.2, action_code: 2, contact_source: 'last_contact_fielder', confidence: 'high' }),
      possessionEvent({ by: 'RF', character: 'Birdo', t: 2.1 }),
    ],
    first_touch: firstTouch({ by: 'RF', character: 'Birdo', t: 2.1 }),
    landing: landing({ t: 1.0 }),
    throws: [throwRecord({ thrower_position: 'RF', thrower_character: 'Birdo', outs_recorded: 1 })],
  })
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'GO', trajectory: 'G', outs_on_play: 1, hit_angle_deg: 30 }),
    play,
    join: join('joined'),
  })
  const body = text(narrative)
  assert.match(body, /Birdo \(RF\) contacted the ball but failed to secure it\./)
  assert.match(body, /Birdo \(RF\) secured the ball after it landed/)
  assert.match(body, /threw to Peach \(1B\) at first/)
  assert.match(body, /An out was recorded on that throw\./)
})

test('a fumble the fielder still got the out on is ruled no error, not left undetermined', () => {
  const play = trackingPlay({
    fielding_events: [
      fieldingEvent({ ball_contact: 'confirmed', by: '2B', character: 'Yellow Yoshi', t: 1.1, action_code: 2, confidence: 'high', contact_source: 'last_contact_fielder' }),
      possessionEvent({ by: '2B', character: 'Yellow Yoshi', t: 1.8 }),
    ],
    first_touch: firstTouch({ by: '2B', character: 'Yellow Yoshi', t: 1.8 }),
    landing: landing({ t: 1.0 }),
    throws: [throwRecord({ thrower_position: '2B', thrower_character: 'Yellow Yoshi', outs_recorded: 1 })],
  })
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'GO', trajectory: 'G', outs_on_play: 1, batter_name: 'Blooper' }),
    play,
    join: join('joined'),
  })
  const body = text(narrative)
  assert.match(body, /No error is charged for that failure to secure: Blooper was still retired/)
  assert.match(body, /failing to complete a double play is not itself an error/)
  assert.doesNotMatch(body, /No official error determination is available/)
  assert.doesNotMatch(body, /scorer's call/)
})

test('a runner who advanced on that fumble leaves the advance to the scorer', () => {
  const play = trackingPlay({
    fielding_events: [
      fieldingEvent({ ball_contact: 'confirmed', by: '2B', character: 'Yellow Yoshi', t: 1.1, action_code: 2, confidence: 'high', contact_source: 'last_contact_fielder' }),
      possessionEvent({ by: '2B', character: 'Yellow Yoshi', t: 1.8 }),
    ],
    first_touch: firstTouch({ by: '2B', character: 'Yellow Yoshi', t: 1.8 }),
    landing: landing({ t: 1.0 }),
    throws: [throwRecord({ thrower_position: '2B', thrower_character: 'Yellow Yoshi', outs_recorded: 1 })],
  })
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({
      result: 'GO', trajectory: 'G', outs_on_play: 1, batter_name: 'Blooper',
      runner_assignments: [
        { isBatter: true, origin: 'the plate', destination: 'out', runner: { characterName: 'Blooper' } },
        { isBatter: false, origin: 'third', destination: 'home', runner: { characterName: 'Birdo' } },
        { isBatter: false, origin: 'first', destination: 'first', runner: { characterName: 'Blue Yoshi' } },
      ],
    }),
    play,
    join: join('joined'),
  })
  const body = text(narrative)
  assert.match(body, /Whether it let Birdo advance is the scorer's call/)
  assert.doesNotMatch(body, /Blue Yoshi advance is the scorer/)
})

test('a fumble on a play the batter survived is still an open scoring question', () => {
  const play = trackingPlay({
    fielding_events: [
      fieldingEvent({ ball_contact: 'confirmed', by: '2B', character: 'Yellow Yoshi', t: 1.1, action_code: 2, confidence: 'high', contact_source: 'last_contact_fielder' }),
      possessionEvent({ by: '2B', character: 'Yellow Yoshi', t: 1.8 }),
    ],
    first_touch: firstTouch({ by: '2B', character: 'Yellow Yoshi', t: 1.8 }),
    landing: landing({ t: 1.0 }),
  })
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: '1B', trajectory: 'G', batter_name: 'Blooper' }),
    play,
    join: join('joined'),
  })
  const body = text(narrative)
  assert.match(body, /No official error determination is available for that failure to secure/)
  assert.doesNotMatch(body, /No error is charged for that failure to secure/)
})

test('a bobble recovered by ANOTHER fielder names the recovery as one', () => {
  const play = trackingPlay({
    batted_ball_class: 'fair_caught',
    caught_in_flight: true,
    fielding_events: [
      fieldingEvent({ ball_contact: 'confirmed', by: '2B', character: 'Brown Kritter', t: 1.1, action_code: 2, confidence: 'high', contact_source: 'last_contact_fielder' }),
      possessionEvent({ by: 'CF', character: 'Light Blue Yoshi', t: 1.9 }),
    ],
    first_touch: firstTouch({ by: 'CF', character: 'Light Blue Yoshi', t: 1.9 }),
    after_deflection: true,
    rebound_catch: {
      deflected_by: '2B', saved_by: 'CF', start_frame: 1100, catch_frame: 1180,
      opportunity_s: 0.8, distance_needed_units: 6.2, start_at: [1, 0, -40], catch_at: [4, 0, -46],
    },
  })
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'FO', trajectory: 'F', outs_on_play: 1, hit_angle_deg: 0 }),
    play,
    join: join('joined'),
  })
  assert.match(text(narrative), /The center fielder recovered the ball after the second baseman could not hold it\./)
})

test('a Yoshi Egg forced contact is its own mechanic, never an ordinary boot', () => {
  const play = trackingPlay({
    fielding_events: [fieldingEvent({
      mechanic: 'egg', action_code: 5, ball_contact: 'confirmed', by: '1B',
      character: 'Peach', confidence: 'high', contact_source: 'last_contact_fielder',
    })],
    forced_misplays: [fieldingEvent({ mechanic: 'egg', action_code: 5, ball_contact: 'confirmed', by: '1B' })],
  })
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: '1B', trajectory: 'G', hit_angle_deg: 34 }),
    play,
    join: join('joined'),
  })
  assert.match(text(narrative), /A Yoshi Egg forced Peach \(1B\) to misplay the first contact\./)
  assert.doesNotMatch(text(narrative), /contacted the ball but failed to secure/)
})

test('a Buddy handoff is a mechanic, not a fielding failure', () => {
  const play = trackingPlay({
    fielding_events: [fieldingEvent({
      mechanic: 'buddy', action_code: 7, ball_contact: 'confirmed', secured: true, by: 'CF',
      character: 'King K. Rool', confidence: 'high', contact_source: 'last_contact_fielder',
    })],
    buddy_handoffs: [fieldingEvent({ mechanic: 'buddy', action_code: 7 })],
  })
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: '1B', trajectory: 'L', hit_angle_deg: 0 }),
    play,
    join: join('joined'),
  })
  // Action code 7 is controlled possession followed by an intentional toss.
  // Chemistry is separate: the lower-case mechanic can be named without
  // inventing a Buddy Throw pairing.
  assert.match(text(narrative), /King K\. Rool \(CF\) secured and redirected the ball to another fielder with a buddy toss\./)
  assert.doesNotMatch(text(narrative), /Buddy Throw/)

  // With a Buddy Throw naming this fielder as the partner it IS a Buddy
  // handoff, and the partner is named rather than left as "the chemistry partner".
  const corroborated = buildTrackerNarrative({
    atBat: plateAppearance({ result: '1B', trajectory: 'L', hit_angle_deg: 0 }),
    play: trackingPlay({
      fielding_events: [fieldingEvent({
        mechanic: 'buddy', action_code: 7, ball_contact: 'confirmed', secured: true, by: 'CF',
        character: 'King K. Rool', confidence: 'high', contact_source: 'last_contact_fielder',
      })],
      buddy_handoffs: [fieldingEvent({ mechanic: 'buddy', action_code: 7 })],
      throws: [throwRecord({
        buddy_throw: true, buddy_thrower_position: 'RF', buddy_partner_position: 'CF',
        thrower_position: 'RF', receiver_position: '1B',
      })],
    }),
    join: join('joined'),
  })
  assert.match(text(corroborated), /King K\. Rool \(CF\) secured and redirected the ball to the right fielder with a buddy toss during the Buddy sequence\./)
})

test('a completed Buddy Throw names both fielders and says the velocity is not an arm', () => {
  const play = trackingPlay({
    throws: [throwRecord({
      buddy_throw: true, buddy_freeze_s: 1.0, buddy_thrower_position: 'SS',
      buddy_partner_position: 'CF', thrower_position: 'SS', thrower_character: 'Blue Pianta',
      receiver_position: '1B', receiver_character: 'Dark Bones', peak_speed_mph: 121.4,
    })],
  })
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'GO', trajectory: 'G', outs_on_play: 1, hit_angle_deg: -20 }),
    play,
    join: join('joined'),
  })
  assert.match(text(narrative), /Blue Pianta \(SS\) and the center fielder completed a Buddy Throw to Dark Bones \(1B\) at first at 121 mph\./)
  const clause = narrative.clauses.find((entry) => entry.category === 'throw')
  assert.match(clause.evidence.note, /not an arm measurement/)
})

test('a failed Buddy Throw sequence produces no Buddy Throw sentence', () => {
  const play = trackingPlay({
    throws: [throwRecord({ buddy_throw: false, thrower_position: 'SS', receiver_position: '1B' })],
  })
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: '1B', trajectory: 'G', hit_angle_deg: -20 }),
    play,
    join: join('joined'),
  })
  assert.doesNotMatch(text(narrative), /Buddy Throw/)
})

test('a successful Buddy Jump is announced, and a failed one is announced as failed', () => {
  const made = buildTrackerNarrative({
    atBat: plateAppearance({
      result: 'FO', trajectory: 'F', outs_on_play: 1, hit_angle_deg: -30,
      is_buddy_jump: true, buddy_jump_assist_position: 8, buddy_jump_putout_position: 7,
    }),
  })
  assert.match(text(made), /A Buddy Jump was completed with help from position 8, and position 7 made the catch\./)

  const failed = buildTrackerNarrative({
    atBat: plateAppearance({
      result: '2B', trajectory: 'F', hit_angle_deg: -30,
      is_buddy_jump: false, buddy_jump_putout_position: 7,
    }),
  })
  assert.match(text(failed), /A Buddy Jump was attempted and did not produce an out\./)
})

test('a relay says it was thrown on, and an intended target that differs is called coverage', () => {
  const play = trackingPlay({
    throws: [
      throwRecord({ sequence: 1, thrower_position: 'LF', thrower_character: 'Mario', receiver_position: 'SS', receiver_character: 'Waluigi', target_base: 'second', is_relay: false }),
      throwRecord({ sequence: 2, thrower_position: 'SS', thrower_character: 'Waluigi', receiver_position: '2B', receiver_character: 'Daisy', target_base: 'second', is_relay: true, intended_target_position: 'SS' }),
    ],
  })
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: '2B', trajectory: 'L', hit_angle_deg: -30 }),
    play,
    join: join('joined'),
  })
  const body = text(narrative)
  assert.match(body, /Waluigi \(SS\) threw on to Daisy \(2B\) at second/)
  assert.match(body, /That throw was aimed at the shortstop; the second baseman covered and took it\./)
})

test('runners advancing, scoring and being retired each get their own sentence', () => {
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({
      result: '1B',
      trajectory: 'G',
      hit_angle_deg: 20,
      rbi: 1,
      runners_before: { first: 'Peach', second: null, third: 'Daisy' },
      runner_on_first_before: true,
      runner_on_third_before: true,
      runs_scored: [{ scoring_character_name: 'Daisy', charged_to_pitcher_name: 'Bowser', is_earned_run: true }],
      runner_assignments: [
        runnerAssignment({ id: 'batter', destination: 'first' }),
        runnerAssignment({ id: 'first', runner: { characterName: 'Peach' }, origin: 'first', isBatter: false, destination: 'second' }),
        runnerAssignment({ id: 'third', runner: { characterName: 'Daisy' }, origin: 'third', isBatter: false, destination: 'home' }),
      ],
    }),
  })
  const body = text(narrative)
  assert.match(body, /Luigi reached first\./)
  assert.match(body, /Peach advanced from first to second\./)
  assert.match(body, /Daisy scored from third\./)
  assert.match(body, /1 run scored on the play, with 1 RBI credited to Luigi\./)
})

test('a retired runner is named as retired, and the batter-runner stays distinct', () => {
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({
      result: 'FC', trajectory: 'G', outs_on_play: 1, fielder_choice_out: true, hit_angle_deg: -18,
      runners_before: { first: 'Peach', second: null, third: null },
      runner_on_first_before: true,
      runner_assignments: [
        runnerAssignment({ id: 'batter', destination: 'first' }),
        runnerAssignment({ id: 'first', runner: { characterName: 'Peach' }, origin: 'first', isBatter: false, destination: 'out' }),
      ],
    }),
  })
  const body = text(narrative)
  assert.match(body, /Luigi reached first\./)
  assert.match(body, /Peach was retired coming from first\./)
})

test('unresolved runner assignments are flagged rather than omitted', () => {
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({
      result: '1B', trajectory: 'G', hit_angle_deg: 10,
      runners_before: { first: 'Peach', second: null, third: null },
      runner_on_first_before: true,
      runner_assignments: null,
    }),
  })
  assert.match(text(narrative), /could not resolve where every runner finished/)
})

test('a mapped ability is neither claimed nor noisily caveated without activation evidence', () => {
  const play = trackingPlay({
    caught_in_flight: true,
    batted_ball_class: 'fair_caught',
    first_touch: firstTouch({ by: 'RF', character: 'Birdo' }),
    fielding_events: [possessionEvent({ by: 'RF', character: 'Birdo' })],
  })
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'FO', trajectory: 'F', outs_on_play: 1, hit_angle_deg: 30 }),
    play,
    join: join('joined'),
  })
  const body = text(narrative)
  assert.match(body, /Birdo \(RF\) secured the ball before it landed\./)
  assert.doesNotMatch(body, /Birdo used Suction Catch/)
  assert.doesNotMatch(body, /Suction Catch/)
})

test('the complete Sluggers fielding roster has an activation rule for every named ability', () => {
  const mappings = {
    Magikoopa: 'Magical Catch',
    'Red Magikoopa': 'Magical Catch',
    Yoshi: 'Tongue Catch',
    Birdo: 'Suction Catch',
    Kritter: 'Keeper Catch',
    'Blue Kritter': 'Keeper Catch',
    Peach: 'Quick Throw',
    'Baby Peach': 'Quick Throw',
    Wario: 'Laser Beam',
    'Blue Noki': 'Ball Dash',
    Goomba: 'Ball Dash',
    'Baby Luigi': 'Super Jump',
    Daisy: 'Super Dive',
    'Donkey Kong': 'Clamber',
    'Petey Piranha': 'Piranha Catch',
    'Hammer Bro.': 'Hammer Throw',
    'Fire Bro.': 'Fireball Throw',
    'Boomerang Bro.': 'Boomerang Throw',
  }
  for (const [character, ability] of Object.entries(mappings)) {
    assert.equal(fieldingAbilityFor(character), ability, character)
    assert.ok(FIELDING_ABILITY_ACTIVATION[ability], `${ability} has no activation rule`)
  }
  assert.equal(fieldingAbilityFor('Toadette'), null)
})

test('Hammer Throw is named from Hammer Bro own dive input, never from a routine catch', () => {
  const dove = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'GO', trajectory: 'G', outs_on_play: 1, hit_angle_deg: 20 }),
    play: trackingPlay({
      first_touch: firstTouch({ by: '2B', character: 'Hammer Bro.' }),
      fielding_events: [possessionEvent({
        by: '2B', character: 'Hammer Bro.',
        catch_type: 3, approach: 'dive', dive: true,
      })],
    }),
    join: join('joined'),
  })
  const body = text(dove)
  // The approach and the catch are separate observations, so they are separate
  // sentences: a dive that ends in a boot must not read as a made play.
  assert.match(body, /Hammer Bro\. \(2B\) used Hammer Throw to reach the ball\./)
  assert.match(body, /Hammer Bro\. \(2B\) secured the ball/)
  assert.equal(clauseFor(dove, 'approach').status, 'observed')
  assert.equal(clauseFor(dove, 'approach').evidence.catch_type, 3)

  // The same catch without the dive byte says nothing about a dive at all.
  const routine = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'GO', trajectory: 'G', outs_on_play: 1, hit_angle_deg: 20 }),
    play: trackingPlay({
      first_touch: firstTouch({ by: '2B', character: 'Hammer Bro.' }),
      fielding_events: [possessionEvent({ by: '2B', character: 'Hammer Bro.' })],
    }),
    join: join('joined'),
  })
  assert.doesNotMatch(text(routine), /dove|dive/)
  assert.doesNotMatch(text(routine), /Hammer Throw/)
  assert.equal(clauseFor(routine, 'approach'), undefined)
})

// THE ONE INPUT RULE. The game gives the player a single dive/jump button, so a
// character whose mapped ability IS that move cannot perform the move without
// using the ability. The observation and the activation are the same event, and
// reporting only "dove" understates what the capture actually saw.
test('the dive and leap approaches name the ability when it is that character own move', () => {
  const cases = [
    { character: 'Green Shy Guy', catchType: 3, approach: 'dive', dive: true, ability: 'Super Dive' },
    { character: 'Yoshi', catchType: 3, approach: 'dive', dive: true, ability: 'Tongue Catch' },
    { character: 'Birdo', catchType: 3, approach: 'dive', dive: true, ability: 'Suction Catch' },
    { character: 'Magikoopa', catchType: 3, approach: 'dive', dive: true, ability: 'Magical Catch' },
    { character: 'Brown Kritter', catchType: 3, approach: 'dive', dive: true, ability: 'Keeper Catch' },
    { character: 'Petey Piranha', catchType: 3, approach: 'dive', dive: true, ability: 'Piranha Catch' },
    { character: 'Fire Bro.', catchType: 3, approach: 'dive', dive: true, ability: 'Fireball Throw' },
    { character: 'Boomerang Bro.', catchType: 3, approach: 'dive', dive: true, ability: 'Boomerang Throw' },
    { character: 'Baby Luigi', catchType: 6, approach: 'leap', leap: true, ability: 'Super Jump' },
  ]
  for (const entry of cases) {
    const narrative = buildTrackerNarrative({
      atBat: plateAppearance({ result: 'GO', trajectory: 'G', outs_on_play: 1, hit_angle_deg: 20 }),
      play: trackingPlay({
        first_touch: firstTouch({ by: '2B', character: entry.character }),
        fielding_events: [possessionEvent({
          by: '2B',
          character: entry.character,
          catch_type: entry.catchType,
          approach: entry.approach,
          dive: entry.dive === true,
          leap: entry.leap === true,
        })],
      }),
      join: join('joined'),
    })
    const body = text(narrative)
    assert.match(body, new RegExp(`used ${entry.ability} to reach the ball`))
    // And the caveat must not then deny the sentence above it.
    assert.doesNotMatch(body, new RegExp(`not evidence of ${entry.ability}`))
    assert.equal(clauseFor(narrative, 'approach').evidence.ability_resolution.status, 'confirmed')
  }
})

test('a failed special dive is retained even when it never produced a contact event', () => {
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: '1B', trajectory: 'G', hit_angle_deg: 10 }),
    play: trackingPlay({
      landing: landing(),
      catch_approaches: [{
        by: '2B', character_id: 52, character: 'Fire Bro.', catch_type: 3,
        approach: 'dive', dive: true, leap: false,
        start_frame: 10100, end_frame: 10109, start_t: 1.0, end_t: 1.15,
      }],
    }),
    join: join('joined'),
  })
  const body = text(narrative)
  assert.match(body, /Fire Bro\. \(2B\) used Fireball Throw to reach the ball\./)
  assert.match(body, /Fire Bro\. \(2B\) attempted to field the ball but did not make contact\./)
})

test('Quick Throw is named only when the mapped character actually throws', () => {
  const activated = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'GO', trajectory: 'G', outs_on_play: 1 }),
    play: trackingPlay({ throws: [throwRecord({ thrower_character: 'Baby Peach' })] }),
    join: join('joined'),
  })
  assert.match(text(activated), /Baby Peach \(CF\) threw to Peach \(1B\) at first using Quick Throw/)

  const noThrow = buildTrackerNarrative({
    atBat: plateAppearance({ result: '1B', trajectory: 'G' }),
    play: trackingPlay({
      fielding_events: [fieldingEvent({ character: 'Baby Peach', ball_contact: 'confirmed' })],
    }),
    join: join('joined'),
  })
  assert.doesNotMatch(text(noThrow), /Quick Throw/)
})

// A throw home by a Laser Beam character does not show the move firing -- the
// operator watched an ordinary 70 mph throw home get called one, and the
// archive's 31 non-Buddy Laser Beam throws sit on top of everyone else's
// speeds. So the ability is named as unconfirmed, never as used.
test('Laser Beam is reported as unconfirmed on a mapped non-Buddy throw to home', () => {
  const thrownHome = buildTrackerNarrative({
    atBat: plateAppearance({ result: '1B', trajectory: 'L' }),
    play: trackingPlay({
      throws: [throwRecord({
        thrower_character: 'Wario', receiver_position: 'C', receiver_character: 'Peach',
        intended_target_position: 'C', target_base: 'home',
      })],
    }),
    join: join('joined'),
  })
  assert.match(text(thrownHome), /Wario \(CF\) threw to Peach \(C\) at home at \d+ mph\./)
  assert.doesNotMatch(text(thrownHome), /using Laser Beam/)
  assert.match(text(thrownHome), /Wario \(CF\) has Laser Beam, but nothing in this throw confirms it fired\./)

  const ordinaryTarget = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'GO', trajectory: 'G', outs_on_play: 1 }),
    play: trackingPlay({ throws: [throwRecord({ thrower_character: 'Wario', target_base: 'first' })] }),
    join: join('joined'),
  })
  assert.doesNotMatch(text(ordinaryTarget), /Laser Beam/)
})

// Ball Dash has no move and no input: a mapped character simply runs faster
// while holding the ball. So the sentence reports the measured carry and names
// the ability as the passive it is -- and a mapped character who never carries
// has not failed to use anything.
test('Ball Dash is reported as a passive on the measured carry, never as a move', () => {
  const activated = buildTrackerNarrative({
    atBat: plateAppearance({ result: '1B', trajectory: 'G' }),
    play: trackingPlay({
      possession_carries: [{
        by: 'CF', character_id: 30, character: 'Goomba', start_frame: 10100,
        end_frame: 10130, start_t: 1.5, end_t: 2, distance_units: 3.25,
        displacement_units: 3.1, peak_speed_ups: 8.4,
      }],
    }),
    join: join('joined'),
  })
  assert.match(
    text(activated),
    /Goomba \(CF\) carried the ball 3\.3 units at up to 8\.4 u\/s, with Ball Dash, which is a passive carry-speed bonus rather than a move\./,
  )
  assert.doesNotMatch(text(activated), /used Ball Dash/)
  assert.equal(clauseFor(activated, 'ability').evidence.status, 'passive')

  const tooShort = buildTrackerNarrative({
    atBat: plateAppearance({ result: '1B', trajectory: 'G' }),
    play: trackingPlay({
      possession_carries: [{ by: 'CF', character: 'Goomba', distance_units: 0.4 }],
    }),
    join: join('joined'),
  })
  assert.doesNotMatch(text(tooShort), /Ball Dash/)

  // The thing this ability must never produce: a caveat saying the tracker did
  // not see it. There is nothing to see.
  const standingStill = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'FO', trajectory: 'F', outs_on_play: 1, hit_angle_deg: 0 }),
    play: trackingPlay({
      caught_in_flight: true,
      batted_ball_class: 'fair_caught',
      first_touch: firstTouch({ by: 'CF', character: 'Goomba' }),
      fielding_events: [possessionEvent({ by: 'CF', character: 'Goomba' })],
    }),
    join: join('joined'),
  })
  assert.doesNotMatch(text(standingStill), /Ball Dash/)
})

// A ball hit hard enough drives the fielder who caught it backwards. That
// covers ground while holding the ball, so it used to be measured as a carry
// and -- for a Ball Dash character -- credited as the passive. The operator
// flagged it twice in one DK Jungle session: "did not use ball dash to run,
// they got pushed back by the power of the hit."
test('a fielder driven back by the hit is not carrying the ball', () => {
  const knocked = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'LO', trajectory: 'L', outs_on_play: 1 }),
    play: trackingPlay({
      possession_carries: [{
        by: 'CF', character_id: 24, character: 'Blue Noki', start_frame: 53808,
        end_frame: 53925, start_t: 1.2, end_t: 3.15, distance_units: 10.87,
        displacement_units: 10.87, peak_speed_ups: 16.7, motion: 'knockback',
      }],
    }),
    join: join('joined'),
  })
  assert.match(
    text(knocked),
    /Blue Noki \(CF\) was driven back 10\.9 units while holding the ball rather than running with it; the capture does not say what pushed them\./,
  )
  // The whole point: no ability claim survives on a knockback.
  assert.doesNotMatch(text(knocked), /Ball Dash/)
  assert.equal(clauseFor(knocked, 'ability'), undefined)

  // And the same character, same distance, self-directed, still gets it.
  const carried = buildTrackerNarrative({
    atBat: plateAppearance({ result: '1B', trajectory: 'G' }),
    play: trackingPlay({
      possession_carries: [{
        by: 'CF', character_id: 24, character: 'Blue Noki', start_frame: 53808,
        end_frame: 53925, start_t: 1.2, end_t: 3.15, distance_units: 10.87,
        displacement_units: 9.2, peak_speed_ups: 16.7, motion: 'carry',
      }],
    }),
    join: join('joined'),
  })
  assert.match(text(carried), /with Ball Dash/)
  assert.doesNotMatch(text(carried), /driven back/)
})

// MSS runs an A/B button-mash contest when a runner and a throw reach a base
// together, and unlike the freeze and the knockback the capture NAMES its
// outcome: `fielder+0x246` is 1 when the fielder held on and 2 when the runner
// knocked the ball loose. The operator asked for this repeatedly across six
// sessions -- "i was hoping to keep a stat track of users performance of the
// close play" -- and the losing case is also the one that must stop reading as
// a fielding mistake.
test('a close play names who won it, and an unknown value claims nothing', () => {
  const lost = buildTrackerNarrative({
    atBat: plateAppearance({ result: '3B', trajectory: 'L' }),
    play: trackingPlay({
      close_plays: [{
        by: '3B', character_id: 47, character: 'Gray Shy Guy', t: 13.4968,
        frame: 41196, frames: 121, seconds: 2.0187, flag_value: 2, won_by: 'runner',
      }],
    }),
    join: join('joined'),
  })
  assert.match(
    text(lost),
    /Gray Shy Guy \(3B\) was in a close play and lost it; the runner knocked the ball out of their hands, which is the contest and not a fielding mistake\./,
  )

  const held = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'GO', trajectory: 'G', outs_on_play: 1 }),
    play: trackingPlay({
      close_plays: [{
        by: 'C', character_id: 24, character: 'Blue Noki', t: 8.2,
        frame: 42612, frames: 100, seconds: 1.6684, flag_value: 1, won_by: 'fielder',
      }],
    }),
    join: join('joined'),
  })
  assert.match(text(held), /Blue Noki \(C\) was in a close play and won it; the runner was retired\./)

  // A value neither onset in the archive has produced. The contest is still
  // reported -- it measurably happened -- and the outcome is not invented.
  const unknown = buildTrackerNarrative({
    atBat: plateAppearance({ result: '2B', trajectory: 'L' }),
    play: trackingPlay({
      close_plays: [{
        by: 'C', character_id: 24, character: 'Blue Noki', t: 8.2,
        frame: 42612, frames: 90, seconds: 1.5, flag_value: 7, won_by: null,
      }],
    }),
    join: join('joined'),
  })
  assert.match(text(unknown), /Blue Noki \(C\) was in a close play; the capture does not say who won\./)
  assert.doesNotMatch(text(unknown), /lost it|won it/)

  // And a play with no contest says nothing at all.
  const ordinary = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'GO', trajectory: 'G', outs_on_play: 1 }),
    play: trackingPlay({ close_plays: [] }),
    join: join('joined'),
  })
  assert.doesNotMatch(text(ordinary), /close play/)
})

// A LEAPING CATCH IS NOT A KNOCKBACK, and its kinematics are identical: the
// fielder is fastest on the first frame, never speeds up and travels dead
// straight, because they are still riding the jump they started before the
// ball arrived. The operator flagged one at Peach Ice Garden -- "think it was
// his momentum of running and jumping to the ball" -- and the airborne flag on
// the possession frame is what tells the two apart.
test('a leaping catch is narrated as the leap, not as the force of the ball', () => {
  const leapt = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'LO', trajectory: 'L', outs_on_play: 1 }),
    play: trackingPlay({
      possession_carries: [{
        by: 'SS', character_id: 59, character: 'Blue Kritter', start_frame: 44724,
        end_frame: 44790, start_t: 1.4, end_t: 2.5, distance_units: 1.95,
        displacement_units: 1.95, peak_speed_ups: 6.1, motion: 'knockback',
        airborne_at_start: true, impulse: 'leap', impulse_frame: 44724,
      }],
    }),
    join: join('joined'),
  })
  assert.match(
    text(leapt),
    /Blue Kritter \(SS\) carried 1\.9 units past the catch on their own leap rather than being driven back by the ball\./,
  )
  assert.doesNotMatch(text(leapt), /driven back 1\.9 units/)
  assert.doesNotMatch(text(leapt), /force of the batted ball/)
  // A leap is no more evidence of Ball Dash than a shove is.
  assert.doesNotMatch(text(leapt), /Ball Dash/)
})

// DK Jungle's barrel is the first stadium hazard the capture can see, so it is
// also the first one the narrative may name a cause for. It is reported only
// when it reached somebody -- a barrel crossing an empty outfield changed
// nothing, and narrating those would bury the ones that did.
test('a barrel that reaches a fielder is narrated, and one that misses is not', () => {
  const hit = buildTrackerNarrative({
    atBat: plateAppearance({ result: '1B', trajectory: 'G' }),
    play: trackingPlay({
      barrel_events: [{
        sequence: 1, from_cannon: 'left', distance_units: 41.2,
        peak_height_units: 17.4, start_t: 1.1, start_frame: 5000,
        approaches: [
          { by: 'CF', closest_units: 1.2, closest_frame: 5120,
            fielder_moved_units_after: 3.4, hit: true },
          { by: 'RF', closest_units: 18.9, closest_frame: 5090,
            fielder_moved_units_after: 0.2, hit: false },
        ],
        hit_fielders: ['CF'],
      }],
    }),
    join: join('joined'),
  })
  assert.match(
    text(hit),
    /A left-side barrel reached the center fielder, closing to 1\.2 units, and they were moved 3\.4 units after\./,
  )
  // The fielder it passed 19 units from is not in the narrative at all.
  assert.doesNotMatch(text(hit), /right fielder/)

  const missed = buildTrackerNarrative({
    atBat: plateAppearance({ result: '1B', trajectory: 'G' }),
    play: trackingPlay({
      barrel_events: [{
        sequence: 1, from_cannon: 'right', distance_units: 55.0,
        start_t: 0.9, start_frame: 5000, hit_fielders: [],
        approaches: [{ by: 'LF', closest_units: 12.0, closest_frame: 5100,
                       fielder_moved_units_after: 0.0, hit: false }],
      }],
    }),
    join: join('joined'),
  })
  assert.doesNotMatch(text(missed), /barrel/)
})

// The flower flag may name its cause where the Freezie may not, because the
// evidence is different: it fires at every annotated flower spray, at neither
// annotated barrel hit, and nowhere at five other parks.
test('a fielder caught in the flower gas is narrated, and the cause is named', () => {
  const sprayed = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'LO', trajectory: 'L', outs_on_play: 1 }),
    play: trackingPlay({
      flower_sprays: [{ by: 'CF', character_id: 24, character: 'Blue Noki',
                        t: 2.4, frames: 96, seconds: 1.6 }],
    }),
    join: join('joined'),
  })
  assert.match(
    text(sprayed),
    /Blue Noki \(CF\) was caught in the flower gas for 1\.6 s, and was dazed rather than beaten to the ball\./,
  )
  assert.equal(clauseFor(sprayed, 'mechanic').evidence.by, 'CF')

  // Two fielders sprayed at once is a real play, not a duplicate.
  const both = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'FO', trajectory: 'F', outs_on_play: 1 }),
    play: trackingPlay({
      flower_sprays: [
        { by: 'CF', character: 'Blue Noki', t: 1.0, frames: 90, seconds: 1.5 },
        { by: 'RF', character: 'Boomerang Bro.', t: 1.0, frames: 90, seconds: 1.5 },
      ],
    }),
    join: join('joined'),
  })
  assert.match(text(both), /Blue Noki \(CF\) was caught in the flower gas/)
  assert.match(text(both), /Boomerang Bro\. \(RF\) was caught in the flower gas/)
})

// The knockdown flag is park-neutral: it marks the impact, not the cause. So it
// is narrated when nothing else explains it, and suppressed when the barrel
// clause on the same play already names what did it.
test('a knockdown is narrated unless a barrel already explains it', () => {
  const alone = buildTrackerNarrative({
    atBat: plateAppearance({ result: '2B', trajectory: 'L' }),
    play: trackingPlay({
      knockdowns: [{ by: 'RF', character: 'Koopa Troopa', t: 1.8,
                     frame: 6660, frames: 72, seconds: 1.2 }],
    }),
    join: join('joined'),
  })
  assert.match(
    text(alone),
    /Koopa Troopa \(RF\) was knocked down for 1\.2 s; the capture does not name what hit them\./,
  )

  // Same knockdown, but a barrel on the play already accounts for it.
  const explained = buildTrackerNarrative({
    atBat: plateAppearance({ result: '1B', trajectory: 'G' }),
    play: trackingPlay({
      knockdowns: [{ by: 'CF', character: 'Blue Noki', t: 1.5,
                     frame: 37808, frames: 60, seconds: 1.0 }],
      barrel_events: [{
        sequence: 1, from_cannon: 'left', distance_units: 40.0,
        start_t: 1.0, start_frame: 37600, hit_fielders: ['CF'],
        approaches: [{ by: 'CF', closest_units: 1.1, closest_frame: 37800,
                       fielder_moved_units_after: 2.9, hit: true,
                       knocked_down: true, hit_source: 'knockdown_flag' }],
      }],
    }),
    join: join('joined'),
  })
  assert.match(text(explained), /barrel reached the center fielder/)
  assert.doesNotMatch(text(explained), /does not name what hit them/)
})

test('a base throw whose receiver is pulled far off the bag is called inaccurate', () => {
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'GO', trajectory: 'G', outs_on_play: 1 }),
    play: trackingPlay({
      throws: [throwRecord({
        receiver_distance_from_target_units: 4.52,
        receiver_pulled_off_base: true,
      })],
    }),
    join: join('joined'),
  })
  assert.match(text(narrative), /That inaccurate throw pulled Peach \(1B\) 4\.5 units away from first\./)
})

// Clamber's approach code belongs to nobody else. Every catch_type 5 window in
// the archive and in the live sessions belongs to a character mapped to
// Clamber, and those same characters also produce ordinary 1/3/6/7 windows, so
// the code is the mechanic rather than a Kong fingerprint.
test('catch_type 5 is Clamber, and is a mismatch on a character who cannot Clamber', () => {
  const clamber = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'FO', trajectory: 'F', outs_on_play: 1, hit_angle_deg: 0 }),
    play: trackingPlay({
      caught_in_flight: true, batted_ball_class: 'fair_caught',
      first_touch: firstTouch({ by: 'CF', character: 'Donkey Kong' }),
      fielding_events: [possessionEvent({
        by: 'CF', character: 'Donkey Kong', catch_type: 5, approach: 'unresolved',
      })],
    }),
    join: join('joined'),
  })
  assert.match(text(clamber), /Donkey Kong \(CF\) used Clamber to reach the ball\./)
  assert.doesNotMatch(text(clamber), /activation was not confirmed/)

  const impossible = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'FO', trajectory: 'F', outs_on_play: 1, hit_angle_deg: 0 }),
    play: trackingPlay({
      caught_in_flight: true, batted_ball_class: 'fair_caught',
      first_touch: firstTouch({ by: 'CF', character: 'Birdo' }),
      fielding_events: [possessionEvent({
        by: 'CF', character: 'Birdo', catch_type: 5, approach: 'unresolved',
      })],
    }),
    join: join('joined'),
  })
  assert.match(text(impossible), /Birdo used the Clamber approach, which the roster says they do not have/)
  assert.doesNotMatch(text(impossible), /Birdo \(CF\) used Clamber to reach the ball/)
})

test('an unresolved special fielding action is named as unresolved and carries its raw code', () => {
  const play = trackingPlay({
    fielding_events: [fieldingEvent({
      mechanic: 'special_unknown', action_code: 8, ball_contact: 'unknown',
      by: 'LF', character: 'Daisy',
    })],
  })
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: '1B', trajectory: 'L', hit_angle_deg: -30 }),
    play,
    join: join('joined'),
  })
  const body = text(narrative)
  assert.match(body, /Daisy \(LF\) used an unresolved special fielding action; the tracker could not determine whether contact occurred\./)
  // The mapped ability MAY be mentioned as context -- what must never happen is
  // the action being reported as that ability having been used.
  assert.doesNotMatch(body, /used Super Dive/)
  assert.match(body, /cannot yet name \(their mapped ability is Super Dive\)/)
  const clause = narrative.clauses.find((entry) => entry.category === 'mechanic')
  assert.equal(clause.evidence.unresolved_action_code, 8)
  assert.equal(clause.evidence.ability_resolution.status, 'unresolved')
  assert.equal(clause.evidence.ability_resolution.mappedAbility, 'Super Dive')
})

// Action code 4 is NOT one of those. Every window carrying it, across five
// sessions of plays, belongs to a ball Mario hit, and the operator names the
// mechanic: the Fire Swing fireball, which the first fielder to reach it
// cannot hold. It is the batter's ability acting on the fielder.
test("action code 4 is the batter's star ball, not a fielding ability of the fielder's", () => {
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'ROE', trajectory: 'G', batter_name: 'Mario' }),
    play: trackingPlay({
      batter: 'Mario',
      fielding_events: [fieldingEvent({
        mechanic: 'star_ball', action_code: 4, ball_contact: 'confirmed',
        by: '3B', character: 'Blue Yoshi',
      })],
    }),
    join: join('joined'),
  })
  const body = text(narrative)
  assert.match(body, /Mario's fireball forced Blue Yoshi \(3B\) to lose the first contact\./)
  assert.doesNotMatch(body, /Tongue Catch/)
  assert.doesNotMatch(body, /unresolved special fielding action/)
})

test('a star swing IS named, because the tracker announced the activation', () => {
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'HR', trajectory: 'F', star_hit_used: true, batter_name: 'Mario', hit_angle_deg: 0, hit_distance_ft: 420 }),
  })
  assert.match(text(narrative), /Mario used Fire Swing\./)
  const clause = narrative.clauses.find((entry) => entry.category === 'ability')
  assert.equal(clause.status, 'observed')
  assert.equal(clause.evidence.status, 'confirmed')
})

test('a missed star attempt is separated from the ordinary deciding contact', () => {
  const pitches = pitchSequence(['swinging_miss', 'in_play'])
  pitches[0].is_star_swing = true
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({
      result: 'HR', trajectory: 'F', star_hit_used: true, star_hit_connected: false,
      batter_name: 'Mario', hit_angle_deg: 0, hit_distance_ft: 420, pitches,
    }),
  })
  assert.match(text(narrative), /pitch 1 \(missed\); the deciding pitch was not a star swing/)
})

test('a runner knock-loose is a recovery event, not a relay throw', () => {
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: '3B', trajectory: 'L' }),
    play: trackingPlay({ throws: [throwRecord({
      is_throw: false,
      event_type: 'loose_ball_recovery',
      thrower_position: '3B', thrower_character: 'Gray Shy Guy',
      receiver_position: 'P', receiver_character: 'Green Magikoopa',
      runner_contact: { character: 'Bowser Jr.' },
      caused_by_runner_contact: true,
    })] }),
    join: join('joined'),
  })
  assert.match(text(narrative), /Bowser Jr\. knocked the ball loose from Gray Shy Guy \(3B\); Green Magikoopa \(P\) recovered it\./)
  assert.doesNotMatch(text(narrative), /threw on/)
})

test('an inaccurate throw that lets an arriving runner reach is charged to the thrower', () => {
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({
      result: '1B', trajectory: 'G',
      is_error: true, error_kind: 'throwing',
      error_character: 'Blue Yoshi', error_position: 6, error_notation: 'G6-E6',
    }),
    play: trackingPlay({ throws: [throwRecord({
      target_base: 'third', receiver_position: '3B', intended_target_position: '3B',
      receiver_distance_from_target_units: 2.99, receiver_pulled_off_base: true,
      throwing_error_candidate: true, outs_recorded: 0,
      runner_at_arrival: { character: 'Purple Toad', distance_from_target_units: 1.9, closing_units: 4.6 },
    })] }),
    join: join('joined'),
  })
  const body = text(narrative)
  // The measured fact and the ruling are separate sentences, and only one of
  // them claims a charge.
  assert.match(body, /a wild throw that permitted an advance/)
  assert.match(body, /A throwing error is charged to Blue Yoshi at position 6, from the capture’s own measurement/)
  assert.doesNotMatch(body, /throwing-error candidate/)
})

test('an announced bobble is still charged as an ordinary error, not a throwing one', () => {
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({
      result: 'ROE', trajectory: 'G',
      is_error: true, error_kind: 'fielding',
      error_character: 'Birdo', error_position: 8, error_notation: 'G8-E8',
    }),
    join: join('pending'),
  })
  const body = text(narrative)
  assert.match(body, /An error is charged to Birdo at position 8\./)
  assert.doesNotMatch(body, /A throwing error is charged/)
})

test('a star pitch is named from the announcement plus the mapping', () => {
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'K', pitcher_name: 'Bowser', star_pitch_used: true, star_pitch_successful: true }),
  })
  // Bowser's mapped star pitch is Killer Ball; the name comes from the mapping
  // only because the tracker announced that a star pitch happened at all.
  assert.match(text(narrative), /Bowser used Killer Ball in this plate appearance\./)
})

test('no fielding sentence is produced at all when the join is ambiguous', () => {
  const play = trackingPlay({
    fielding_events: [possessionEvent({ by: 'CF', character: 'Birdo' })],
    first_touch: firstTouch(),
  })
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'FO', trajectory: 'F', hit_angle_deg: 0 }),
    play,
    join: join('ambiguous', { candidate_pa_numbers: [4, 7], reason: '2 at-bats match' }),
  })
  assert.doesNotMatch(text(narrative), /secured the ball/)
  assert.match(text(narrative), /could belong to this at-bat or to another one/)
  assert.equal(narrative.status, 'partial')
})

test('a pending join says the play has not arrived rather than that nobody fielded it', () => {
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'FO', trajectory: 'F', hit_angle_deg: 0 }),
    play: null,
    join: join('pending', { pa_number: null }),
  })
  assert.match(text(narrative), /has not arrived yet/)
  assert.doesNotMatch(text(narrative), /No fielder made a play/)
})

test('a ball nobody touched says nobody touched it', () => {
  const play = trackingPlay({ fielding_events: [], landing: landing({ at: [40, 0.3, -60] }) })
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: '2B', trajectory: 'L', hit_angle_deg: 33 }),
    play,
    join: join('joined'),
  })
  assert.match(text(narrative), /No fielder made a play on the ball; it landed/)
})

test('an in-progress plate appearance is pending, not complete', () => {
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: null, pitches: pitchSequence(['ball', 'looking']) }),
  })
  assert.equal(narrative.status, 'pending')
  assert.match(text(narrative), /has not finished/)
})

test('every clause is traceable: id, category, status, source and evidence', () => {
  const play = trackingPlay({
    caught_in_flight: true,
    first_touch: firstTouch(),
    fielding_events: [possessionEvent()],
    throws: [throwRecord()],
    primary_fielder: 'CF',
    primary_fielder_reason: 'catch',
  })
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'FO', trajectory: 'F', outs_on_play: 1, hit_angle_deg: 0 }),
    play,
    join: join('joined'),
  })
  assert.ok(narrative.clauses.length >= 4)
  const ids = new Set()
  for (const clause of narrative.clauses) {
    assert.ok(clause.id, 'clause needs an id')
    assert.ok(!ids.has(clause.id), `duplicate clause id ${clause.id}`)
    ids.add(clause.id)
    assert.ok(clause.category, 'clause needs a category')
    assert.ok(clause.text, 'clause needs text')
    assert.ok(clause.source, `clause ${clause.id} needs a source`)
    assert.ok(clause.evidence && typeof clause.evidence === 'object', `clause ${clause.id} needs evidence`)
    assert.ok(
      ['observed', 'derived', 'inferred', 'unknown', 'pending', 'not_applicable', 'mismatch'].includes(clause.status),
      `clause ${clause.id} has status ${clause.status}`,
    )
  }
  // The timeline is ordered by the frame each fact happened on.
  const frames = narrative.timeline.map((entry) => entry.frame).filter((value) => value != null)
  assert.deepEqual(frames, [...frames].sort((a, b) => a - b))
})

test('a measured endpoint outranks the spray angle for direction, and says which it used', () => {
  const play = trackingPlay({ landing: landing({ at: [-60, 0.4, -60] }) })
  const narrative = buildTrackerNarrative({
    // The tracker's own spray angle says right field; the measured landing says
    // left. The measurement wins, and the clause says where it came from.
    atBat: plateAppearance({ result: '2B', trajectory: 'L', hit_angle_deg: 30 }),
    play,
    join: join('joined'),
  })
  const clause = clauseFor(narrative, 'contact')
  assert.equal(clause.evidence.direction_source, 'measured_endpoint_coordinates')
  assert.ok(clause.evidence.direction_deg < 0, 'a -X landing is toward left field')
  assert.match(clause.text, /left/)
})

test('with no play joined the direction falls back to the tracker spray angle, labelled', () => {
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: '2B', trajectory: 'L', hit_angle_deg: 30 }),
    play: null,
    join: join('pending', { pa_number: null }),
  })
  const clause = clauseFor(narrative, 'contact')
  assert.equal(clause.evidence.direction_source, 'tracker_spray_angle')
  assert.match(clause.text, /right field/)
})

test('an official error is only stated when the plate appearance charges one', () => {
  const withError = buildTrackerNarrative({
    atBat: plateAppearance({
      result: 'ROE', trajectory: 'G', hit_angle_deg: 10,
      is_error: true, error_character: 'Brown Kritter', error_position: 4,
      fielding_events: { assists: [], putouts: [], bobble: 'Brown Kritter' },
    }),
  })
  assert.match(text(withError), /An error is charged to Brown Kritter at position 4\./)

  const withoutError = buildTrackerNarrative({
    atBat: plateAppearance({ result: '1B', trajectory: 'G', hit_angle_deg: 10 }),
    play: trackingPlay({
      fielding_events: [fieldingEvent({ ball_contact: 'confirmed', by: '2B', character: 'Brown Kritter', confidence: 'high', contact_source: 'last_contact_fielder' })],
    }),
    join: join('joined'),
  })
  assert.doesNotMatch(text(withoutError), /error is charged/)
  assert.match(text(withoutError), /No official error determination is available/)
})

test('"not yet" and "never" are different sentences', () => {
  const atBat = plateAppearance({
    result: 'LO', trajectory: 'L', outs_on_play: 1, hit_angle_deg: -30,
    pitches: pitchSequence(['in_play']),
    runner_assignments: [runnerAssignment({ destination: 'out' })],
  })
  const pending = join('pending', { pa_number: null })

  // A collector that is running and simply has not emitted yet.
  const waiting = buildTrackerNarrative({ atBat, play: null, join: pending, captureStatus: 'recording' })
  assert.match(text(waiting), /has not arrived yet/)
  assert.equal(waiting.clauses.find((c) => c.category === 'join').status, 'pending')

  // A session with no collector at all. The play is not late, it is absent, and
  // an operator told to wait for it would wait forever.
  const none = buildTrackerNarrative({ atBat, play: null, join: pending, captureStatus: 'disabled' })
  assert.match(text(none), /No 60 Hz collector is running for this session/)
  assert.doesNotMatch(text(none), /has not arrived yet/)
  assert.equal(none.clauses.find((c) => c.category === 'join').status, 'not_applicable')
  assert.match(text(none), /npm run tracker:bridge/)

  const failed = buildTrackerNarrative({ atBat, play: null, join: pending, captureStatus: 'failed' })
  assert.match(text(failed), /collector failed for this session/)
  assert.match(text(failed), /none is coming/)
})

// A buddy toss is a secure AND a pass. Reporting the teammate who caught it as
// having "secured the ball after it landed" put two fielders on one batted ball
// and charged the chance to the wrong one.
test('the fielder who takes a buddy toss is described as taking a toss, not as fielding the ball', () => {
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: '1B', trajectory: 'L', hit_angle_deg: 0 }),
    play: trackingPlay({
      landing: landing(),
      primary_fielder: 'CF',
      primary_fielder_reason: 'buddy_handoff',
      fielding_events: [
        fieldingEvent({
          t: 3.47, mechanic: 'buddy', action_code: 7, ball_contact: 'confirmed',
          secured: true, by: 'CF', character: 'Mario',
        }),
        possessionEvent({
          t: 3.92, by: 'RF', character: 'Luigi', mechanic: 'buddy_receive',
          received_from: 'CF', ball_height_units: 0,
        }),
      ],
    }),
    join: join('joined'),
  })
  const body = text(narrative)
  assert.match(body, /Luigi \(RF\) took the ball on the buddy toss from the center fielder\./)
  assert.doesNotMatch(body, /Luigi \(RF\) secured the ball after it landed/)
  assert.match(body, /charges this ball to the center fielder, because they secured it and passed it on with a buddy toss/)
})

// The action byte is an animation state. It fired for one frame while a home
// run was 34.9 units above Donkey Kong's head, and the console reported an
// attempt whose outcome it could not determine -- on a ball nobody could have
// reached.
test('an action window with the ball out of reach is reported as out of reach, not as an attempt', () => {
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'HR', trajectory: 'F', hit_angle_deg: 0, hit_distance_ft: 400 }),
    play: trackingPlay({
      batted_ball_class: 'home_run',
      home_run: true,
      fielding_events: [fieldingEvent({
        by: 'CF', character: 'Donkey Kong', action_code: 2, ball_contact: 'missed',
        contact_source: 'ball_never_within_reach',
        distance_units: 10.449, closest_distance_units: 10.449,
        closest_reach_units: 36.38, within_reach: false,
        ball_at: [0.38, 34.85, -82.12],
      })],
    }),
    join: join('joined'),
  })
  const body = text(narrative)
  assert.match(body, /Donkey Kong \(CF\) was in a fielding animation, but the ball never came within reach/)
  assert.match(body, /36\.4 units away, 34\.9 units overhead/)
  assert.doesNotMatch(body, /could not determine whether contact occurred/)
})

// A Buddy Jump leaves no action window and no possession, so a ball two
// fielders went up for used to come out of the derivation with no fielding
// events at all -- and the console said nobody played it.
test('a Buddy Jump the capture saw is narrated even when the ball left the park', () => {
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'HR', trajectory: 'F', hit_angle_deg: -18, hit_distance_ft: 410 }),
    play: trackingPlay({
      batted_ball_class: 'home_run',
      home_run: true,
      buddy_jumps: [{
        by: 'LF', character_id: 3, character: 'Peach', flag: 2,
        start_frame: 55888, start_t: 3.19, end_frame: 55912, end_t: 3.59, frames: 25,
      }],
    }),
    join: join('joined'),
  })
  const body = text(narrative)
  assert.match(body, /Peach \(LF\) went up for a Buddy Jump at the wall\./)
  assert.doesNotMatch(body, /recorded no fielding attempt and no landing/)
})

// Two seconds of a fielder standing still is not a bad route, and the reader
// has to be told that before they read a blank route column as a gap in the
// capture. The sentence states the state and stops: the object that froze him
// is not in the captured region, so naming it would be a guess.
test('a fielder the game froze is narrated, and the cause is not guessed at', () => {
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: '1B', trajectory: 'L', hit_angle_deg: -20, hit_distance_ft: 210 }),
    play: trackingPlay({
      freezes: [{
        by: 'CF', character_id: 28, character: 'Toadsworth',
        t: 2.619, frames: 121, seconds: 2.019,
      }],
    }),
    join: join('joined'),
  })
  const body = text(narrative)
  assert.match(body, /Toadsworth \(CF\) was frozen for 2\.0 s and could not move/)
  assert.match(body, /no route or reaction is measured/)
  assert.doesNotMatch(body, /Freezie/i)
})

// Miis are not in the game's character table, so the capture only ever has an
// id for them. The tracker log's alignment line has the name.
test('a fielder the capture could not name is named from the announced alignment', () => {
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({
      result: 'GO', trajectory: 'G', outs_on_play: 1, hit_angle_deg: 12,
      fielding_alignment: { '1B': 'Orange Mii (M)' },
    }),
    play: trackingPlay({
      fielding_events: [possessionEvent({ by: '1B', character: 'char 78', character_id: 78 })],
      throws: [throwRecord({
        thrower_position: '1B', thrower_character: 'char 78',
        receiver_position: 'C', receiver_character: 'Blue Noki', target_base: 'home',
      })],
    }),
    join: join('joined'),
  })
  const body = text(narrative)
  assert.match(body, /Orange Mii \(M\) \(1B\)/)
  assert.doesNotMatch(body, /char 78/)
})

// A runner who finishes on the base he started on did not advance. The
// assignment is right -- he is still there -- but "advanced from first to
// first" describes a move that cannot happen.
test('a runner who did not move is held, not advanced from a base to itself', () => {
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({
      result: 'LO', trajectory: 'L', outs_on_play: 1, hit_angle_deg: 12,
      runners_before: { first: 'Mario', second: null, third: null },
      runner_on_first_before: true,
      runner_assignments: [
        runnerAssignment({ id: 'batter', origin: 'plate', isBatter: true, destination: 'out', runner: { characterName: 'Luigi' } }),
        runnerAssignment({ id: 'first', origin: 'first', isBatter: false, destination: 'first', runner: { characterName: 'Mario' } }),
      ],
    }),
  })
  const body = text(narrative)
  assert.match(body, /Mario held at first\./)
  assert.doesNotMatch(body, /advanced from first to first/)
})

// The log announces the attempt on every buddy jump and the completion only on
// the ones that produced an out, so a jump at a ball that cleared the fence has
// the first line and never the second.
test('a Buddy Jump the log announced and no out followed is still narrated', () => {
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({
      result: 'HR', trajectory: 'F', hit_angle_deg: 0, hit_distance_ft: 410,
      buddy_jump_attempt_by: 'Mario', is_buddy_jump: false,
    }),
  })
  assert.match(text(narrative), /Mario went up for a Buddy Jump, and no out followed\./)
})

// The measurement, not the cause. DK Jungle's flower sprays a fielder and
// leaves them dazed and unable to throw; nothing in the capture names that, but
// the delay it produces is the longest hold in the session by a factor of four.
test('a throw held far longer than an ordinary one is reported as measured, with no cause claimed', () => {
  const narrative = buildTrackerNarrative({
    atBat: plateAppearance({ result: '1B', trajectory: 'G', hit_angle_deg: 10 }),
    play: trackingPlay({
      landing: landing(),
      throws: [throwRecord({
        thrower_position: 'CF', thrower_character: 'Mario', hold_s: 2.94,
      })],
    }),
    join: join('joined'),
  })
  const body = text(narrative)
  assert.match(body, /Mario \(CF\) held the ball 2\.9 s before releasing it; an ordinary throw goes inside 1\.5 s\./)
  assert.doesNotMatch(body, /flower|dazed|hazard/i)

  const ordinary = buildTrackerNarrative({
    atBat: plateAppearance({ result: '1B', trajectory: 'G', hit_angle_deg: 10 }),
    play: trackingPlay({ landing: landing(), throws: [throwRecord({ hold_s: 0.7 })] }),
    join: join('joined'),
  })
  assert.doesNotMatch(text(ordinary), /held the ball/)
})

// The margin, not the verdict. Who won a close play is the game's call and is
// already in outs_recorded; how close it was is only in the capture.
//
// AND THE MARGIN IS IN TIME. Distance at the moment the ball lands measures the
// runner's speed as much as the margin, which is how a game with five throws
// this close came to narrate none: the runner beaten by 0.18 s was three units
// out because he was running, and the runner who won by 0.47 s was standing on
// the bag having stopped.
//
// This is NOT the MSS close play, which is a button-mash contest with its own
// flag -- see the close-play test above and `fielder+0x246`.
test('the throw margin is reported in time, safe or out, and a runner long since arrived is not', () => {
  // Beaten by the throw by a fifth of a second, and three units from the bag
  // when it landed because he was still at full speed.
  const out = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'GO', trajectory: 'G', hit_angle_deg: -20, outs_on_play: 1 }),
    play: trackingPlay({
      landing: landing(),
      throws: [throwRecord({
        thrower_position: 'SS', thrower_character: 'Dry Bones',
        receiver_position: '1B', receiver_character: 'Blue Noki',
        target_base: 'first', outs_recorded: 1,
        runner_at_arrival: {
          runner: 'BAT', character_id: 40, character: 'Goomba',
          distance_from_target_units: 3.03, distance_before_units: 7.49,
          closing_units: 4.46, reach_frame: 77343, margin_s: 0.18,
        },
      })],
    }),
    join: join('joined'),
  })
  assert.match(
    text(out),
    /Goomba reached first 0\.18 s after the throw did, and the out was recorded\./,
  )

  // Won it by half a second, and stopped -- which the old distance-and-closing
  // reading threw away as a runner who had been standing there.
  const safe = buildTrackerNarrative({
    atBat: plateAppearance({ result: '1B', trajectory: 'G', hit_angle_deg: 20 }),
    play: trackingPlay({
      landing: landing(),
      throws: [throwRecord({
        target_base: 'second', outs_recorded: 0,
        runner_at_arrival: {
          runner: 'R1', character_id: 24, character: 'Baby DK',
          distance_from_target_units: 0.82, distance_before_units: 1.65,
          closing_units: 0.83, reach_frame: 61050, margin_s: -0.47,
        },
      })],
    }),
    join: join('joined'),
  })
  assert.match(
    text(safe),
    /Baby DK reached second 0\.47 s before the throw did, and no out was recorded\./,
  )

  // A batter who reached first two seconds ago is the same 0.8 units from the
  // bag. The margin is what separates him, and it is not close.
  const standing = buildTrackerNarrative({
    atBat: plateAppearance({ result: '1B', trajectory: 'G', hit_angle_deg: 20 }),
    play: trackingPlay({
      landing: landing(),
      throws: [throwRecord({
        target_base: 'second',
        runner_at_arrival: {
          runner: 'R1', character_id: 1, character: 'Luigi',
          distance_from_target_units: 0.815, distance_before_units: 0.815,
          closing_units: 0, reach_frame: 12000, margin_s: -2.3,
        },
      })],
    }),
    join: join('joined'),
  })
  assert.doesNotMatch(text(standing), /reached second/)

  // And a throw whose nearest runner never went to that base at all.
  const uncontested = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'GO', trajectory: 'G', outs_on_play: 1 }),
    play: trackingPlay({
      landing: landing(),
      throws: [throwRecord({
        target_base: 'second', outs_recorded: 0,
        runner_at_arrival: {
          runner: 'R1', character_id: 1, character: 'Luigi',
          distance_from_target_units: 26.34, distance_before_units: 26.34,
          closing_units: 0, reach_frame: null, margin_s: null,
        },
      })],
    }),
    join: join('joined'),
  })
  assert.doesNotMatch(text(uncontested), /reached second/)
})


// A foul ball produces its own 60 Hz play, and when nothing fair joined the
// at-bat the console shows the foul so the fielding it does have is not
// invisible. That stand-in must never be described as the ball the at-bat was
// decided on: on Baby DK's 2026-08-31 strikeout it read "No fielder made a play
// on the ball; it landed in third base", which named a fair-field zone off a
// foul's angle and claimed a ball in play the plate appearance never had.
test('a foul standing in for a missing fair ball is not narrated as a ball in play', () => {
  const struckOut = buildTrackerNarrative({
    atBat: plateAppearance({ result: 'K', strikeout_type: 'KS', trajectory: null }),
    play: trackingPlay({
      batted_ball_class: 'foul',
      fair_or_foul: -1,
      fielding_events: [],
      landing: landing({ at: [-15.73, 0.26, -14.06] }),
    }),
    join: join('joined'),
  })
  assert.match(text(struckOut), /No fielder made a play on the foul ball\./)
  assert.doesNotMatch(text(struckOut), /it landed in/)
})

test('a fair ball nobody fielded still names the zone it came down in', () => {
  const fell = buildTrackerNarrative({
    atBat: plateAppearance({ result: '1B', trajectory: 'F' }),
    play: trackingPlay({ fielding_events: [], landing: landing() }),
    join: join('joined'),
  })
  assert.match(text(fell), /No fielder made a play on the ball; it landed in .+\./)
})
