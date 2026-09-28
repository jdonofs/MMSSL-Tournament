import assert from 'node:assert/strict'
import test from 'node:test'
import { buildStadiumIncidents } from '../src/utils/stadiumIncidents.js'
import { buildPlayMechanics } from '../src/utils/playerMechanics.js'
import { groupFinalStatEvents } from '../src/utils/finalStatDisplay.js'

const context = {
  park: 'peach_ice_garden', timeOfDay: 'day', competitionType: 'season', gameId: 9,
  sessionVersion: 1, playOrdinal: 2,
  plateAppearance: { character_id: 4, player_id: 'offense' },
  resolveFielder: ({ position }) => position ? { characterId: 7, playerId: 'defense' } : {},
}

test('display groups physical effects by victim, keeps ball contact separate, and exposes legacy coverage', () => {
  const incidents = buildStadiumIncidents({
    contact_timer: 100,
    freezes: [{ by: 'SS', t: 1, frames: 120, seconds: 2 }],
    frozen_fielder_ball_contacts: [{ by: 'SS', frame: 180, outcome: 'rebound' }],
  }, context)
  const plays = [
    { id: 1, competition_type: 'season', game_id: 9, play_ordinal: 2, quality: { stadium_incidents: incidents } },
    { id: 2, competition_type: 'tournament', game_id: 9, play_ordinal: 2, quality: {} },
    { id: 3, competition_type: 'season', game_id: 10, play_ordinal: 1, quality: { quarantined_session: true, stadium_incidents: incidents } },
  ]
  const view = groupFinalStatEvents(plays, 'character', 'stadium')
  assert.equal(view.coveredPlays, 1)
  assert.equal(view.legacyPlays, 1)
  assert.equal(view.quarantinedPlays, 1)
  assert.equal(view.rows.find((row) => row.type === 'player_freeze').count, 1)
  assert.equal(view.rows.find((row) => row.type === 'player_freeze').actorId, '7')
  assert.equal(view.rows.find((row) => row.type === 'frozen_fielder_ball_contact').count, 1)
  assert.equal(view.summary['7'].incidents, 1)
  assert.equal(view.summary['7'].ballInteractions, 1)
})

test('mechanics display preserves attack contact, clear, and star victim semantics', () => {
  const mechanics = buildPlayMechanics({
    buddy_attacks: [
      { by: 'SS', timer: 100, hit: true, clears_freezie: true },
      { by: 'SS', timer: 200, hit: false },
    ],
    star_swing: { start_frame: 300, captain: 'Mario', value: 1 },
    star_swing_effects: [{ by: 'SS', frame: 310, effect: 'stun' }],
  }, context)
  const incidents = buildStadiumIncidents({ star_swing_effects: [{ by: 'SS', frame: 310, effect: 'stun' }] }, context)
  const view = groupFinalStatEvents([{ id: 1, competition_type: 'season', game_id: 9, play_ordinal: 2, quality: { play_mechanics: mechanics, stadium_incidents: incidents } }], 'player', 'mechanics')
  const attacks = view.rows.find((row) => row.type === 'buddy_attack')
  assert.equal(attacks.count, 2)
  assert.equal(attacks.contacts, 1)
  assert.equal(attacks.clears, 1)
  assert.equal(view.rows.find((row) => row.type === 'star_effect_caused').victims, 1)
  assert.equal(view.rows.find((row) => row.type === 'star_effect_suffered_star_effect_stun').role, 'victim')
  assert.equal(view.summary.defense.buddyAttacks, 2)
})

test('a mechanics record names its park, and an old one borrows the capture\'s stadium', () => {
  const closePlay = { close_plays: [{ by: '3B', frame: 500, frames: 109, flag_value: 1, won_by: 'fielder' }] }
  const stamped = buildPlayMechanics(closePlay, context)
  assert.equal(stamped[0].park, 'peach_ice_garden')
  assert.equal(stamped[0].time_of_day, 'day')
  // Recorded before mechanics carried a park: the session's stadium fills in.
  const legacy = stamped.map(({ park, time_of_day: _time, ...rest }) => rest)
  const view = groupFinalStatEvents([
    { id: 1, competition_type: 'season', game_id: 9, play_ordinal: 2, park: 'dk_jungle', quality: { play_mechanics: legacy } },
  ], 'player', 'mechanics')
  assert.equal(view.rows.find((row) => row.type === 'close_play').park, 'dk_jungle')
})
