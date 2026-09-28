// What the PLAYERS did, as opposed to what the stadium did to them.
//
// src/utils/stadiumIncidents.js counts the park's effect on a character. This
// counts the deliberate things characters do that the capture already measures
// and that nothing has ever persisted: Buddy attacks, Buddy Jumps, close-play
// contests, and the captain star effects a batter INFLICTS rather than suffers.
//
// The archive holds 538 buddy attacks, 54 Buddy Jumps, 14 close plays and 48
// star effects, and not one of them reaches the database today. They are not
// stadium luck and never enter it -- a fielder smashing a Freezie with a Buddy
// attack is a play he made, not a park hazard he survived.
//
// TWO THINGS THIS DELIBERATELY DOES NOT DO.
//
//   It does not re-credit a Buddy Jump. The official BJ credit is already
//   scored from the tracker log and displayed; `buddyJumpAttempts` here is the
//   raw +0x223 window, which fires on attempts the log never announces. Adding
//   the two together would count one jump twice, so the field is named for what
//   it is and the official credit stays the official number.
//
//   It does not name an unresolved action. A fielding action the derivation has
//   no name for stays `unknown` with its raw code, exactly as the narrative
//   reports it; a count of "unknown special actions" is a real measurement and
//   a guessed name is not.

export const PLAY_MECHANICS_SCHEMA_VERSION = 1

function list(value) {
  return Array.isArray(value) ? value : []
}

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function actor(event, resolveFielder) {
  const position = event?.by || null
  if (!position) return null
  const identity = resolveFielder({ position, characterId: finite(event.character_id) }) || {}
  return {
    position,
    characterId: finite(identity.characterId),
    playerId: identity.playerId || null,
    trackerCharacterId: finite(event.character_id),
    unresolved: finite(identity.characterId) == null,
  }
}

// THE OTHER SIDE OF A CLOSE PLAY. The capture writes the contest flag on the
// fielder and names the runner beside it (derive_player_metrics.py's
// name_close_play_runners); this resolves that slot to the same identities the
// official baserunning rows use, so a runner is credited from the scorebook's
// own assignment rather than from a tracker character id.
function runnerActor(event, resolveRunner) {
  const slot = event?.runner || null
  if (!slot) return null
  const identity = resolveRunner({ slot, characterId: finite(event.runner_character_id) }) || {}
  return {
    slot,
    characterId: finite(identity.characterId),
    playerId: identity.playerId || null,
    trackerCharacterId: finite(event.runner_character_id),
    unresolved: finite(identity.characterId) == null,
  }
}

/**
 * The measured player mechanics on one derived play.
 *
 * Pure, and shaped like the stadium contract so a consumer can treat both the
 * same way: a list of records, each naming an actor and carrying its evidence.
 */
export function buildPlayMechanics(play = {}, {
  competitionType = null, gameId = null, sessionVersion = null, playOrdinal = null,
  plateAppearance = null, resolveFielder = () => ({}), resolveRunner = () => ({}),
  park = null, timeOfDay = 'unknown',
} = {}) {
  const records = []
  const id = (type, frame, position) => [
    competitionType ?? 'unknown', gameId ?? 'unknown', sessionVersion ?? 1,
    playOrdinal ?? 'unknown', type, frame ?? 'noframe', position ?? 'noactor',
  ].join('/')

  for (const raw of list(play.buddy_attacks)) {
    const who = actor(raw, resolveFielder)
    records.push({
      schema_version: PLAY_MECHANICS_SCHEMA_VERSION,
      id: id('buddy_attack', raw.timer, who?.position),
      type: 'buddy_attack',
      actor: who,
      frame: finite(raw.timer),
      t: finite(raw.t),
      duration_frames: finite(raw.frames),
      // THE ANIMATION AND THE CONTACT ARE TWO BYTES. +0x265 says the fielder
      // swung, +0x267 latches only when the swing connected, so an attack that
      // hit empty air is an attempt and not a contact.
      contact: Boolean(raw.hit),
      // ...and clearing an object needs the OBJECT's own disappearance on that
      // attack, not the contact latch. attribute_freezie_breaks sets this.
      cleared_object: Boolean(raw.clears_freezie),
    })
  }

  for (const raw of list(play.buddy_jumps)) {
    const who = actor(raw, resolveFielder)
    records.push({
      schema_version: PLAY_MECHANICS_SCHEMA_VERSION,
      id: id('buddy_jump_attempt', raw.start_frame, who?.position),
      type: 'buddy_jump_attempt',
      actor: who,
      frame: finite(raw.start_frame),
      t: finite(raw.start_t),
      duration_frames: finite(raw.frames),
      // The byte takes two values and only 2 is the announced Buddy Jump; 1 is
      // some other state of the same byte and is carried rather than guessed at.
      flag_value: finite(raw.flag),
    })
  }

  for (const raw of list(play.close_plays)) {
    const who = actor(raw, resolveFielder)
    records.push({
      schema_version: PLAY_MECHANICS_SCHEMA_VERSION,
      id: id('close_play', raw.frame, who?.position),
      type: 'close_play',
      actor: who,
      frame: finite(raw.frame),
      t: finite(raw.t),
      duration_frames: finite(raw.frames),
      // The game's own contest result: 1 the fielder held on, 2 the runner
      // knocked it loose. A third value has never been observed and would stay
      // unnamed rather than be invented.
      won_by: raw.won_by || null,
      flag_value: finite(raw.flag_value),
      // A close play is a contest between two characters, and for as long as
      // the record named only the fielder the runner who won or lost it had
      // nothing to show for it anywhere. The separation is carried with the
      // name because it is the evidence the naming rests on.
      runner: runnerActor(raw, resolveRunner),
      runner_separation_units: finite(raw.runner_separation_units),
    })
  }

  for (const raw of list(play.buddy_handoffs)) {
    const who = actor(raw, resolveFielder)
    records.push({
      schema_version: PLAY_MECHANICS_SCHEMA_VERSION,
      id: id('buddy_handoff', raw.frame, who?.position),
      type: 'buddy_handoff',
      actor: who,
      frame: finite(raw.frame),
      t: finite(raw.t),
    })
  }

  // THE CAUSING SIDE OF A STAR EFFECT. The suffering side is a stadium-contract
  // incident (the byte is written on the fielder); the captain who swung is the
  // BATTER of this plate appearance, and the game's own flag names which
  // captain it was. Credited to the batter's identity, never to a fielder.
  const swing = play.star_swing || null
  const effects = list(play.star_swing_effects)
  if (swing && (effects.length || list(play.knockdowns).some((row) => row?.hazard === 'star_swing'))) {
    const victims = effects.length
      + list(play.knockdowns).filter((row) => row?.hazard === 'star_swing').length
    records.push({
      schema_version: PLAY_MECHANICS_SCHEMA_VERSION,
      id: id('star_effect_caused', swing.start_frame, 'BAT'),
      type: 'star_effect_caused',
      actor: plateAppearance
        ? {
          position: 'BAT',
          characterId: finite(plateAppearance.character_id),
          playerId: plateAppearance.player_id || null,
          unresolved: finite(plateAppearance.character_id) == null,
        }
        : null,
      frame: finite(swing.start_frame),
      duration_frames: finite(swing.frames),
      captain: swing.captain || null,
      captain_value: finite(swing.value),
      // One swing can disable several fielders. The activation is one event
      // with a victim COUNT; it is not one event per victim, and the victims
      // themselves are counted on the stadium-incident side.
      victims,
    })
  }

  // Where it happened, stamped the way stadium incidents are, so the Mechanics
  // table can name the park instead of "Unknown park".
  return records.map((record) => ({ ...record, park, time_of_day: timeOfDay }))
}

function emptyRow() {
  return {
    buddyAttacks: 0,
    buddyAttacksWithContact: 0,
    buddyObjectClears: 0,
    buddyJumpAttempts: 0,
    buddyHandoffs: 0,
    closePlays: 0,
    closePlaysWon: 0,
    closePlaysLost: 0,
    // The same contests from the RUNNER's side, counted separately because
    // they are a different skill: won here means the runner knocked the ball
    // loose, which is the fielder's loss on the line above.
    closePlaysRun: 0,
    closePlaysRunWon: 0,
    closePlaysRunLost: 0,
    starEffectsCaused: 0,
    starEffectVictimsCaused: 0,
    distinctPlays: 0,
  }
}

/**
 * Per-actor mechanics totals, by database player or character id.
 *
 * Quarantined sessions are rejected, matching every other official summary.
 */
export function summarizeMechanics(trackingPlays = [], identity = 'player', {
  includeQuarantined = false,
} = {}) {
  const idField = identity === 'character' ? 'characterId' : 'playerId'
  const grouped = {}
  const plays = new Map()

  for (const play of trackingPlays || []) {
    if (!includeQuarantined && play?.quality?.quarantined_session === true) continue
    const playKey = String(play?.id ?? `${play?.competition_type}:${play?.game_id}:${play?.play_ordinal}`)
    // One record can credit TWO people -- a close play is a contest -- so the
    // row is looked up per credit rather than once per record. An unresolved
    // side is skipped on its own and does not cost the other one its credit.
    const credit = (who, apply) => {
      const id = who?.[idField]
      if (id == null) return
      const key = String(id)
      if (!grouped[key]) grouped[key] = emptyRow()
      if (!plays.has(key)) plays.set(key, new Set())
      plays.get(key).add(playKey)
      apply(grouped[key])
    }
    for (const record of list(play?.quality?.play_mechanics)) {
      switch (record.type) {
        case 'buddy_attack':
          credit(record.actor, (row) => {
            row.buddyAttacks += 1
            if (record.contact) row.buddyAttacksWithContact += 1
            if (record.cleared_object) row.buddyObjectClears += 1
          })
          break
        case 'buddy_jump_attempt':
          credit(record.actor, (row) => { row.buddyJumpAttempts += 1 })
          break
        case 'buddy_handoff':
          credit(record.actor, (row) => { row.buddyHandoffs += 1 })
          break
        case 'close_play':
          credit(record.actor, (row) => {
            row.closePlays += 1
            if (record.won_by === 'fielder') row.closePlaysWon += 1
            if (record.won_by === 'runner') row.closePlaysLost += 1
          })
          // The runner's side of the same contest. `won_by` is the game's own
          // result and reads the opposite way here: the runner knocking the
          // ball loose is the runner winning.
          credit(record.runner, (row) => {
            row.closePlaysRun += 1
            if (record.won_by === 'runner') row.closePlaysRunWon += 1
            if (record.won_by === 'fielder') row.closePlaysRunLost += 1
          })
          break
        case 'star_effect_caused':
          credit(record.actor, (row) => {
            row.starEffectsCaused += 1
            row.starEffectVictimsCaused += finite(record.victims) ?? 0
          })
          break
        default: break
      }
    }
  }

  for (const [key, row] of Object.entries(grouped)) {
    row.distinctPlays = plays.get(key)?.size || 0
  }
  return grouped
}
