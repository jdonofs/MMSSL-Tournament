import test from 'node:test'
import assert from 'node:assert/strict'

import { buildPlayMechanics, summarizeMechanics } from '../src/utils/playerMechanics.js'

const context = {
  competitionType: 'season',
  gameId: 71,
  sessionVersion: 1,
  playOrdinal: 3,
  plateAppearance: { character_id: 5, player_id: 'offense-owner' },
  resolveFielder: ({ position }) => (
    position ? { position, playerId: 'defense-owner', characterId: 47 } : {}
  ),
}

test('a Buddy attack separates the swing, the contact and the object it cleared', () => {
  // Three different bytes and three different claims. +0x265 says the animation
  // ran, +0x267 latches only on contact, and clearing a Freezie needs the
  // OBJECT's own disappearance -- the latch alone does not prove it broke
  // anything, which is why attribute_freezie_breaks sets clears_freezie.
  const records = buildPlayMechanics({
    buddy_attacks: [
      { by: '2B', character_id: 47, character: 'Gray Shy Guy', t: 1.88, timer: 20919, frames: 53, hit: true, clears_freezie: true },
      { by: 'LF', character_id: 39, character: 'Dixie Kong', t: 2.10, timer: 21100, frames: 48, hit: true, clears_freezie: false },
      { by: 'RF', character_id: 40, character: 'Goomba', t: 3.00, timer: 21400, frames: 44, hit: false, clears_freezie: false },
    ],
  }, context)

  assert.equal(records.length, 3)
  assert.deepEqual(records.map((row) => [row.contact, row.cleared_object]),
    [[true, true], [true, false], [false, false]])
  const summary = summarizeMechanics([{ id: 1, quality: { play_mechanics: records } }], 'player')['defense-owner']
  assert.equal(summary.buddyAttacks, 3)
  assert.equal(summary.buddyAttacksWithContact, 2, 'a swing at empty air is an attempt, not a contact')
  assert.equal(summary.buddyObjectClears, 1)
})

test('a raw Buddy Jump window is an attempt and never a second official credit', () => {
  const records = buildPlayMechanics({
    buddy_jumps: [
      { by: 'LF', character_id: 18, character: 'Monty Mole', flag: 2, start_frame: 7483, start_t: 3.77, frames: 166 },
    ],
  }, context)
  assert.equal(records[0].type, 'buddy_jump_attempt')
  assert.equal(records[0].flag_value, 2)
  const summary = summarizeMechanics([{ id: 1, quality: { play_mechanics: records } }], 'player')['defense-owner']
  // The field is named for what it is. The official BJ credit is scored from
  // the tracker log elsewhere; summing the two would count one jump twice.
  assert.equal(summary.buddyJumpAttempts, 1)
  assert.equal(summary.buddyAttacks, 0, 'a jump is not an attack')
})

test('a close play records the game\'s own verdict, not an inferred one', () => {
  const records = buildPlayMechanics({
    close_plays: [
      { by: '3B', character_id: 36, t: 12.2, frame: 21891, frames: 107, flag_value: 1, won_by: 'fielder' },
      { by: '1B', character_id: 37, t: 4.0, frame: 22400, frames: 90, flag_value: 2, won_by: 'runner' },
      { by: 'SS', character_id: 38, t: 6.0, frame: 23000, frames: 80, flag_value: 3, won_by: null },
    ],
  }, context)
  const summary = summarizeMechanics([{ id: 1, quality: { play_mechanics: records } }], 'player')['defense-owner']
  assert.equal(summary.closePlays, 3)
  assert.equal(summary.closePlaysWon, 1)
  assert.equal(summary.closePlaysLost, 1)
  // An unobserved third value is counted as a close play and as neither
  // outcome, rather than being folded into one of the two that are known.
  assert.equal(summary.closePlaysWon + summary.closePlaysLost, 2)
})

test('a star swing is credited to the batter who swung, once, with a victim count', () => {
  const records = buildPlayMechanics({
    star_swing: { value: 5, captain: 'Peach', start_frame: 20300, end_frame: 20420, frames: 120 },
    star_swing_effects: [
      { by: '2B', character_id: 11, t: 1.95, frame: 20350, frames: 120, flag: 'sprayed', effect: 'heart' },
      { by: 'SS', character_id: 12, t: 1.97, frame: 20355, frames: 120, flag: 'sprayed', effect: 'heart' },
    ],
  }, context)

  const caused = records.filter((row) => row.type === 'star_effect_caused')
  assert.equal(caused.length, 1, 'one activation, not one per victim')
  assert.equal(caused[0].captain, 'Peach')
  assert.equal(caused[0].victims, 2)
  // Credited to the BATTER's identity. The fielders it disabled are counted on
  // the stadium-incident side as effects suffered.
  assert.equal(caused[0].actor.playerId, 'offense-owner')
  assert.equal(caused[0].actor.characterId, 5)

  const owners = summarizeMechanics([{ id: 1, quality: { play_mechanics: records } }], 'player')
  assert.equal(owners['offense-owner'].starEffectsCaused, 1)
  assert.equal(owners['offense-owner'].starEffectVictimsCaused, 2)
  assert.equal(owners['defense-owner'], undefined, 'the defence caused nothing')
})

test('a star swing that disabled nobody produces no caused record', () => {
  const records = buildPlayMechanics({
    star_swing: { value: 5, captain: 'Peach', start_frame: 20300, frames: 120 },
  }, context)
  assert.deepEqual(records, [], 'the swing happened; it is the EFFECT that is being counted')
})

test('mechanics ids are stable across re-ingestion and distinct per session version', () => {
  const play = { buddy_attacks: [{ by: '2B', character_id: 47, timer: 20919, frames: 53, hit: true }] }
  assert.equal(buildPlayMechanics(play, context)[0].id, buildPlayMechanics(play, context)[0].id)
  assert.notEqual(
    buildPlayMechanics(play, context)[0].id,
    buildPlayMechanics(play, { ...context, sessionVersion: 2 })[0].id,
  )
})

test('an unresolvable fielder keeps the record and stays unresolved', () => {
  const [record] = buildPlayMechanics(
    { buddy_attacks: [{ by: 'CF', character_id: 78, character: 'Orange Mii (M)', timer: 100, hit: true }] },
    { ...context, resolveFielder: () => ({}) },
  )
  assert.equal(record.actor.characterId, null)
  assert.equal(record.actor.playerId, null)
  assert.equal(record.actor.unresolved, true)
  assert.equal(record.actor.trackerCharacterId, 78)
  // It contributes to no owner's line rather than to a guessed one.
  assert.deepEqual(summarizeMechanics([{ id: 1, quality: { play_mechanics: [record] } }], 'player'), {})
})

test('quarantined sessions contribute no mechanics, and distinct plays are counted once', () => {
  const attack = (timer) => buildPlayMechanics(
    { buddy_attacks: [{ by: '2B', character_id: 47, timer, frames: 40, hit: true }] }, context)[0]
  const plays = [
    { id: 1, quality: { play_mechanics: [attack(10), attack(20)] } },
    { id: 2, quality: { play_mechanics: [attack(30)] } },
    { id: 3, quality: { quarantined_session: true, play_mechanics: [attack(40)] } },
  ]
  const summary = summarizeMechanics(plays, 'player')['defense-owner']
  assert.equal(summary.buddyAttacks, 3, 'the quarantined session is excluded')
  assert.equal(summary.distinctPlays, 2)
})
