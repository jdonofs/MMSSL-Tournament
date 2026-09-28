import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CONFIDENCE,
  FAMILY,
  buildStadiumIncidents,
  canonicalHazard,
  eventFrame,
  stadiumIncidentTotals,
  summarizeStadiumIncidents,
} from '../src/utils/stadiumIncidents.js'

// THE FIXTURES ARE PRODUCER-SHAPED. Every object below is the shape
// scripts/derive_player_metrics.py actually writes -- checked against the 50
// derived sessions in data/player_tracking -- rather than a shape convenient to
// assert on. That is the whole reason the manhole defect survived: the old
// test's `{ hazard: 'manhole' }` was not what the deriver emits.

const context = {
  park: 'wario_city',
  timeOfDay: 'night',
  competitionType: 'season',
  gameId: 71,
  sessionVersion: 1,
  playOrdinal: 4,
  resolveFielder: ({ position }) => (
    position ? { position, playerId: 'defense-owner', characterId: 31 } : {}
  ),
}

test('the deriver spelling of a manhole knockdown survives normalization', () => {
  // derive_player_metrics.name_manhole_knockdowns writes `manhole_water`; the
  // site's whitelist said `manhole`, and all 19 archived manhole knockdowns
  // were dropped in silence. Both spellings have to land on one canonical type.
  assert.equal(canonicalHazard('manhole_water'), 'manhole_water')
  assert.equal(canonicalHazard('manhole'), 'manhole_water')

  const [incident] = buildStadiumIncidents({
    contact_timer: 32000,
    knockdowns: [{
      by: 'RF', character_id: 42, character: 'Red Koopa Troopa',
      t: 1.5, frame: 32090, frames: 79, seconds: 1.318,
      hazard: 'manhole_water', manhole_distance_units: 3.41,
      manhole_at: [30.0, -0.4, -75.0],
    }],
  }, context)

  assert.equal(incident.type, 'manhole_water_knockdown')
  assert.equal(incident.family, FAMILY.ACTOR_EFFECT)
  assert.equal(incident.victim.position, 'RF')
  assert.equal(incident.victim.characterId, 31)
  assert.equal(incident.victim.playerId, 'defense-owner')
  assert.equal(incident.cause.confidence, CONFIDENCE.FLAG_NAMED)
  assert.equal(incident.duration_frames, 79)
  assert.equal(incident.park, 'wario_city')
  assert.equal(incident.time_of_day, 'night')
})

test('a freeze and a frozen fielder touching the ball are two different facts', () => {
  // The archive holds 116 freezes and 13 frozen-fielder ball contacts, and the
  // old adapter counted only the 13 -- so "times frozen" read as a fifth of the
  // truth and the freeze itself was invisible. On all ten archived plays that
  // have both, they are the same fielder: one freeze, and separately one ball
  // interaction, never two freezes.
  const incidents = buildStadiumIncidents({
    contact_timer: 71489,
    freezes: [{
      by: 'SS', character_id: 40, character: 'Goomba',
      t: 1.56, frame: 71581, frames: 173, seconds: 2.886,
    }],
    frozen_fielder_ball_contacts: [{
      by: 'SS', character_id: 40, character: 'Goomba',
      t: 22.5, frame: 82838, outcome: 'rebound',
      distance_units: 1.262, trajectory_turn_degrees: 165.006,
    }],
  }, { ...context, park: 'peach_ice_garden' })

  const freezes = incidents.filter((row) => row.type === 'player_freeze')
  const contacts = incidents.filter((row) => row.type === 'frozen_fielder_ball_contact')
  assert.equal(freezes.length, 1)
  assert.equal(contacts.length, 1)
  assert.equal(freezes[0].family, FAMILY.ACTOR_EFFECT)
  // The ball interaction has no VICTIM: the ball met a frozen body, it did not
  // freeze anybody. Counting it as an actor effect is how one freeze becomes two.
  assert.equal(contacts[0].family, FAMILY.BALL_INTERACTION)
  assert.equal(contacts[0].victim, null)
  assert.equal(contacts[0].initiator.position, 'SS')
  assert.equal(freezes[0].duration_seconds, 2.886)
})

test('a freeze with no captured Freezie keeps an unknown cause', () => {
  // Six of the ten Peach sessions never captured the Freezie object array, and
  // 92 of the 116 freezes are in them. The effect is measured; the cause is not.
  const [freeze] = buildStadiumIncidents({
    contact_timer: 6019,
    freezes: [{ by: 'RF', character_id: 35, character: 'Green Magikoopa', t: 2.0, frames: 120, seconds: 2.002 }],
  }, { ...context, park: 'peach_ice_garden' })
  assert.equal(freeze.cause.type, 'freezie')
  assert.equal(freeze.cause.confidence, CONFIDENCE.UNKNOWN)

  // ...and where the object WAS captured, the deriver's measured proximity
  // promotes it. All 24 onsets in the three sessions that recorded the array
  // had an active Freezie 2.64-3.59u away.
  const [proven] = buildStadiumIncidents({
    contact_timer: 6019,
    freezes: [{
      by: 'RF', character_id: 35, character: 'Green Magikoopa',
      t: 2.0, frame: 6140, frames: 120, seconds: 2.002, freezie_distance_units: 2.83,
    }],
  }, { ...context, park: 'peach_ice_garden' })
  assert.equal(proven.cause.confidence, CONFIDENCE.OBJECT_CONFIRMED)
})

test('a freeze derived before the onset frame existed still gets a stable frame', () => {
  // Every archived freeze carries only `t`. Reconstructing the absolute frame
  // from the play's own contact timer is exact, and it is what lets an old
  // session and a re-derived one produce the same incident id.
  assert.equal(eventFrame({ t: 2.0 }, { contact_timer: 6019 }, 59.94), 6139)
  assert.equal(eventFrame({ frame: 6140, t: 2.0 }, { contact_timer: 6019 }, 59.94), 6140)
  assert.equal(eventFrame({}, {}, 59.94), null)
})

test('train knockdowns keep the strength of the evidence that named them', () => {
  // 56 of the archive's 79 train knockdowns are the fence-band inference and 23
  // are the captured train position. The old adapter emitted both as one
  // indistinguishable "Train knockdown".
  const incidents = buildStadiumIncidents({
    contact_timer: 74800,
    knockdowns: [
      { by: 'LF', character_id: 4, character: 'Baby Mario', t: 1.0, frame: 74862, frames: 79,
        hazard: 'train', hazard_source: 'train_position', train_distance_units: 5.2 },
      { by: 'CF', character_id: 9, character: 'Diddy Kong', t: 2.0, frame: 74920, frames: 79,
        hazard: 'train', hazard_source: 'fence_band', fence_inside_units: 3.1 },
    ],
  }, { ...context, park: 'yoshi_park' })

  assert.deepEqual(incidents.map((row) => row.cause.confidence),
    [CONFIDENCE.OBJECT_CONFIRMED, CONFIDENCE.INFERRED])
  assert.deepEqual(incidents.map((row) => row.cause.source), ['train_position', 'fence_band'])
  // Both are still train knockdowns and both are still counted. The evidence
  // grade is a separate field, not a reason to discard the weaker one.
  assert.ok(incidents.every((row) => row.type === 'train_knockdown'))
})

test('an unnamed knockdown is preserved as unknown rather than dropped or guessed', () => {
  // 46 of 199. Bowser Jr. Playroom has 16 with no detector for the object at
  // all, and DK Jungle has 24 the operator's notes say are barrels. Neither may
  // be renamed by elimination, and neither may disappear.
  const [incident] = buildStadiumIncidents({
    contact_timer: 9677,
    knockdowns: [{ by: 'CF', character_id: 59, character: 'Blue Kritter', t: 2.9, frame: 9850, frames: 79 }],
  }, { ...context, park: 'dk_jungle' })
  assert.equal(incident.type, 'knockdown_unknown_cause')
  assert.equal(incident.cause.type, null)
  assert.equal(incident.cause.confidence, CONFIDENCE.UNKNOWN)
  assert.equal(incident.victim.position, 'CF')
})

test('a barrel hit is read from the nested approach, and a near miss is not a hit', () => {
  // detect_barrel_events emits INTERVALS carrying approaches[]; `by` and `hit`
  // are fields of an approach. name_star_swing_knockdowns read them off the
  // interval, so its barrel exclusion collected a set of undefined and never
  // fired -- latent only because no archived session contains a barrel event.
  const incidents = buildStadiumIncidents({
    contact_timer: 9677,
    barrel_events: [{
      sequence: 1, start_frame: 9800, end_frame: 9900, from_cannon: 'left',
      distance_units: 48.2,
      approaches: [
        { by: 'CF', character_id: 59, closest_units: 0.8, closest_frame: 9850,
          knocked_down: true, knocked_down_frame: 9850, hit: true, hit_source: 'knockdown_flag' },
        { by: 'RF', character_id: 60, closest_units: 6.1, closest_frame: 9861,
          knocked_down: false, knocked_down_frame: null, hit: false, hit_source: 'knockdown_flag' },
      ],
      hit_fielders: ['CF'],
    }],
  }, { ...context, park: 'dk_jungle' })

  assert.equal(incidents.length, 1, 'the near miss is evidence, not an incident')
  assert.equal(incidents[0].type, 'barrel_knockdown')
  assert.equal(incidents[0].victim.position, 'CF')
  assert.equal(incidents[0].cause.confidence, CONFIDENCE.FLAG_NAMED)

  // The pre-flag fallback is a weaker claim and says so.
  const [fallback] = buildStadiumIncidents({
    contact_timer: 9677,
    barrel_events: [{ approaches: [{ by: 'CF', character_id: 59, closest_units: 1.9,
      closest_frame: 9850, hit: true, hit_source: 'distance_fallback' }] }],
  }, { ...context, park: 'dk_jungle' })
  assert.equal(fallback.cause.confidence, CONFIDENCE.INFERRED)
})

test('a captain star effect is counted but never attributed to the stadium', () => {
  const incidents = buildStadiumIncidents({
    contact_timer: 20000,
    star_swing_effects: [{
      by: '2B', character_id: 11, character: 'Waluigi', t: 1.95, frame: 20350,
      frames: 120, seconds: 2.002, flag: 'sprayed', effect: 'heart',
      star_swing_captain: 'Peach', star_swing_value: 5,
    }],
    knockdowns: [{ by: 'LF', character_id: 8, t: 1.0, frame: 20100, frames: 79, hazard: 'star_swing' }],
  }, { ...context, park: 'mario_stadium' })

  assert.ok(incidents.every((row) => row.cause.player_caused),
    'Mario Stadium is the negative control: it has no stadium mechanics at all')
  assert.equal(incidents.find((row) => row.type === 'star_effect_heart').victim.position, '2B')
  assert.equal(incidents.find((row) => row.type === 'star_swing_knockdown').cause.type, 'star_swing')
})

test('an object break separates the intentional clear from the incidental one', () => {
  const incidents = buildStadiumIncidents({
    contact_timer: 20840,
    freezie_breaks: [
      { slot: 0, t: 1.43, frame: 20926, distance_units: 6.194,
        cause: { type: 'fielder_buddy_attack', by: '2B', character_id: 47, character: 'Gray Shy Guy' } },
      { slot: 2, t: 3.10, frame: 21030, distance_units: 1.2, cause: { type: 'batted_ball' } },
      { slot: 3, t: 4.00, frame: 21100, cause: { type: 'unknown' } },
    ],
  }, { ...context, park: 'peach_ice_garden' })

  const [attack, batted, unknown] = incidents
  assert.equal(attack.intentional, true)
  assert.equal(attack.initiator.position, '2B')
  assert.equal(batted.intentional, false, 'the batted ball breaking it is stadium luck, not a mechanic')
  assert.equal(batted.initiator, null)
  assert.equal(unknown.cause.confidence, CONFIDENCE.UNKNOWN)
  assert.ok(incidents.every((row) => row.family === FAMILY.OBJECT_CHANGE && row.victim === null))
})

test('two victims on one play are two incidents with two ids', () => {
  const incidents = buildStadiumIncidents({
    contact_timer: 25014,
    knockdowns: [
      { by: 'LF', character_id: 1, t: 3.8, frame: 25246, frames: 79, phases: [[1, 39], [2, 40]] },
      { by: 'CF', character_id: 2, t: 3.2, frame: 25209, frames: 79, phases: [[1, 39], [2, 40]] },
    ],
  }, { ...context, park: 'dk_jungle' })
  assert.equal(incidents.length, 2)
  assert.equal(new Set(incidents.map((row) => row.id)).size, 2)
  assert.deepEqual(incidents.map((row) => row.victim.position), ['LF', 'CF'])
})

test('the same actor hit twice on one play is two incidents, not one', () => {
  const incidents = buildStadiumIncidents({
    contact_timer: 6600,
    knockdowns: [
      { by: 'C', character_id: 3, t: 1.0, frame: 6660, frames: 79, hazard: 'manhole_water' },
      { by: 'C', character_id: 3, t: 3.1, frame: 6789, frames: 79, hazard: 'manhole_water' },
    ],
  }, context)
  assert.equal(incidents.length, 2, 'the operator watched the manhole do it twice to one fielder')
  assert.equal(new Set(incidents.map((row) => row.id)).size, 2)
})

test('incident ids are stable across re-derivation and distinct across versions', () => {
  const play = {
    contact_timer: 32000,
    knockdowns: [{ by: 'RF', character_id: 42, t: 1.5, frame: 32090, frames: 79, hazard: 'manhole_water' }],
  }
  const first = buildStadiumIncidents(play, context)[0]
  const again = buildStadiumIncidents(play, context)[0]
  assert.equal(first.id, again.id, 're-ingesting the same capture must not move a total')

  // A replacement version is built beside the superseded one and both hold
  // facts, so their incidents must not collide while both are on disk.
  const replacement = buildStadiumIncidents(play, { ...context, sessionVersion: 2 })[0]
  assert.notEqual(first.id, replacement.id)

  // The same numeric game id in the other competition is a different game.
  const otherCompetition = buildStadiumIncidents(play, { ...context, competitionType: 'tournament' })[0]
  assert.notEqual(first.id, otherCompetition.id)

  // A late identity resolution changes WHO, never WHICH EVENT.
  const resolvedLater = buildStadiumIncidents(play, {
    ...context, resolveFielder: ({ position }) => ({ position, playerId: 'other', characterId: 99 }),
  })[0]
  assert.equal(first.id, resolvedLater.id)
  assert.equal(resolvedLater.victim.characterId, 99)
})

test('an unresolvable character stays unresolved rather than becoming the pitcher', () => {
  const [incident] = buildStadiumIncidents({
    contact_timer: 32000,
    knockdowns: [{ by: 'RF', character_id: 42, character: 'Some Mii', t: 1.5, frame: 32090, hazard: 'manhole_water' }],
  }, { ...context, resolveFielder: () => ({}) })
  assert.equal(incident.victim.characterId, null)
  assert.equal(incident.victim.playerId, null)
  assert.equal(incident.victim.unresolved, true)
  // The capture's own id is kept as evidence and is NOT written into the
  // database column: the two id spaces overlap and name different characters.
  assert.equal(incident.victim.trackerCharacterId, 42)
})

test('summaries count victims, distinct plays and durations as separate numbers', () => {
  const incident = (over) => ({
    schema_version: 1, family: FAMILY.ACTOR_EFFECT, type: 'player_freeze',
    park: 'peach_ice_garden', duration_frames: 120, duration_seconds: 2.002,
    cause: { confidence: CONFIDENCE.UNKNOWN, player_caused: false },
    victim: { position: 'SS', playerId: 'owner-a', characterId: 40 }, initiator: null,
    ...over,
  })
  const plays = [
    { id: 1, quality: { stadium_incidents: [incident({ id: 'a' }), incident({ id: 'b' })] } },
    { id: 2, quality: { stadium_incidents: [incident({ id: 'c' })] } },
    { id: 3, quality: { stadium_incidents: [{ ...incident({ id: 'd' }), family: FAMILY.BALL_INTERACTION,
      type: 'arrow_redirect', victim: null, initiator: null }] } },
  ]

  const owners = summarizeStadiumIncidents(plays, 'player')['owner-a']
  assert.equal(owners.incidents, 3, 'three physical incidents')
  assert.equal(owners.distinctPlays, 2, 'across two plays')
  assert.equal(owners.byType.player_freeze, 3)
  assert.equal(owners.unknownCauseIncidents, 3)
  assert.equal(owners.durationSeconds, 6.006)
  // The arrow redirect has no identified actor, so it belongs to the play and
  // to nobody's line.
  assert.equal(owners.ballInteractions, 0)

  const totals = stadiumIncidentTotals(plays)
  assert.equal(totals.incidents, 4)
  assert.equal(totals.actorEffects, 3)
  assert.equal(totals.ballInteractions, 1)
  assert.equal(totals.plays, 3)
})

test('quarantined evidence is excluded from official totals but kept on the play', () => {
  const play = {
    id: 9,
    quality: {
      quarantined_session: true,
      stadium_incidents: [{
        id: 'q', family: FAMILY.ACTOR_EFFECT, type: 'player_freeze', park: 'peach_ice_garden',
        cause: { confidence: CONFIDENCE.UNKNOWN }, victim: { playerId: 'owner-a', characterId: 40 },
      }],
    },
  }
  assert.deepEqual(summarizeStadiumIncidents([play], 'player'), {})
  assert.equal(stadiumIncidentTotals([play]).incidents, 0)
  // Retained for diagnostics, and reachable on request.
  assert.equal(summarizeStadiumIncidents([play], 'player', { includeQuarantined: true })['owner-a'].incidents, 1)
  assert.equal(play.quality.stadium_incidents.length, 1)
})

test('a play with no stadium evidence contributes nothing rather than a zero row', () => {
  assert.deepEqual(summarizeStadiumIncidents([{ id: 1, quality: {} }], 'player'), {})
  assert.deepEqual(buildStadiumIncidents({ contact_timer: 1 }, context), [])
  assert.equal(stadiumIncidentTotals([{ id: 1, quality: {} }]).plays, 0)
})
