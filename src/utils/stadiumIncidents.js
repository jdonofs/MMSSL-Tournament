// What the stadium actually DID, as opposed to who it favoured.
//
// src/utils/gimmickLuck.js answers one question -- which owner got the better
// of a stadium interaction -- and it answers it as a zero-sum score. That makes
// it structurally unable to answer the question the site actually wants: how
// many times was THIS character frozen, hit by a barrel, sprayed. A luck event
// has a beneficiary and an unlucky side, and neither of them is necessarily the
// character the stadium touched. One Freezie that freezes the shortstop is:
//
//   * ONE physical incident, whose victim is the shortstop,
//   * ONE affected play,
//   * 2.0 seconds of duration,
//   * ZERO ball interactions until the ball actually hits him, and
//   * ONE luck point to the offense.
//
// Those are five different numbers and the old summary could only produce the
// last one. Worse, summing luck's two sides to count "physical events" doubles
// every incident, because each event credits one side and debits the other.
//
// So this module keeps the concepts apart by construction:
//
//   PHYSICAL INCIDENT   something happened to a character. Has a victim.
//   BALL INTERACTION    the ball was moved, held or struck. Has no victim; a
//                       redirected ball does not hurt anybody.
//   OBJECT CHANGE       a stadium object broke. Has an initiator, and may be
//                       INTENTIONAL (a Buddy attack, a throw) or incidental.
//
// NOTHING HERE INVENTS A CAUSE. Every incident carries the evidence that named
// it and a confidence drawn from what the capture actually proved, and an
// effect whose cause is unmeasured stays `unknown` rather than being assigned
// to whatever hazard the park is famous for. See CONFIDENCE below.

/**
 * The contract version. Bump when the emitted shape changes in a way a stored
 * event cannot be read under; the ingester stamps it onto every persisted
 * event so a mixed database stays readable.
 */
export const STADIUM_INCIDENT_SCHEMA_VERSION = 1

/**
 * HOW WELL THE CAUSE IS KNOWN, from what the capture measured -- not a score.
 *
 * Every value below is earned by a specific kind of evidence that exists in the
 * archive today; see the per-type tables further down for which detector
 * produces which.
 *
 *   object_confirmed  the object's own captured state or position proves it.
 *                     The train at 0x811F84DC beside the floored fielder, a
 *                     Daisy table's transform at the ball contact, a Freezie's
 *                     own active byte dropping 1 -> 0.
 *   flag_named        a game flag whose meaning is established, read in a park
 *                     where exactly one thing writes it. The manhole knockdown,
 *                     King Bob-omb's two-phase flag, DK's statue POW at value 1.
 *   inferred          geometry or kinematics excluded everything else. The
 *                     fence-band train fallback, the old barrel distance
 *                     fallback, a Daisy stun located at the stunned fielder.
 *   unknown           the EFFECT is measured and the cause is not. A bare
 *                     knockdown flag, a freeze in a session that never captured
 *                     the Freezie array.
 *
 * `unknown` is a first-class answer and is counted, never dropped: 46 of the
 * archive's 199 knockdowns are unnamed, and a coverage number that hid them
 * would claim a completeness the capture does not have.
 */
export const CONFIDENCE = Object.freeze({
  OBJECT_CONFIRMED: 'object_confirmed',
  FLAG_NAMED: 'flag_named',
  INFERRED: 'inferred',
  UNKNOWN: 'unknown',
})

export const FAMILY = Object.freeze({
  ACTOR_EFFECT: 'actor_effect',
  BALL_INTERACTION: 'ball_interaction',
  OBJECT_CHANGE: 'object_change',
})

/**
 * Producer spelling -> canonical type.
 *
 * THIS IS THE BUG THAT MADE THIS TABLE NECESSARY. The deriver writes
 * `hazard: 'manhole_water'` (derive_player_metrics.py, name_manhole_knockdowns)
 * and gimmickLuck.js's whitelist accepted `'manhole'`, so all 19 archived
 * manhole knockdowns were silently discarded on their way to the site -- a
 * whitelist miss returns nothing, never an error. Both spellings resolve here,
 * and tests/stadium-incidents.test.mjs feeds the producer's own output through
 * so a future rename fails a test instead of emptying a column.
 */
export const HAZARD_ALIASES = Object.freeze({
  manhole: 'manhole_water',
  manhole_water: 'manhole_water',
  manhole_knockdown: 'manhole_water',
  barrel: 'barrel',
  piranha_plant: 'piranha_plant',
  train: 'train',
  bob_omb_bomb: 'bob_omb_bomb',
  falling_lava: 'falling_lava',
  statue_fire: 'statue_fire',
  dk_pow: 'dk_pow',
  star_swing: 'star_swing',
})

/** The canonical name for a hazard the deriver wrote, or null if unnamed. */
export function canonicalHazard(value) {
  const key = String(value || '').trim().toLowerCase()
  return HAZARD_ALIASES[key] || (key ? key : null)
}

// A captain's star swing is a PLAYER action that happens to write the same
// bytes a stadium hazard does. It is preserved as an incident so "star effects
// suffered" is countable, but it is never stadium luck and never a park
// mechanic -- see STAR_SWING in the type table.
const PLAYER_CAUSED = new Set(['star_swing'])

function list(value) {
  return Array.isArray(value) ? value : []
}

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/**
 * The frame an event happened on, or null.
 *
 * `freezes[]` carried only `t` (seconds since contact) until the deriver was
 * changed to record the onset timer beside it, so an archived session derived
 * before that has no frame for a freeze. The reconstruction is exact -- the
 * play's own contact frame plus the onset offset at the game's 60 Hz clock --
 * and is used only when the producer supplied none.
 */
export function eventFrame(event = {}, play = {}, fps = 59.94) {
  const direct = finite(event.frame ?? event.start_frame ?? event.timer)
  if (direct != null) return direct
  const contact = finite(play.contact_timer)
  const offset = finite(event.t ?? event.start_t)
  if (contact == null || offset == null) return null
  return Math.round(contact + offset * fps)
}

/**
 * A stable identity for one incident.
 *
 * Scoped to the competition, the game, the tracking session version and the
 * play, then to what happened inside it. Stability is the whole point: a
 * re-ingest, a session replacement, a late identity resolution and a PA
 * correction must all produce the SAME id for the same physical event, or every
 * total moves when nothing happened. So the id is built from the capture's own
 * facts -- type, frame, affected position -- and never from a row id, an array
 * index or a resolved character, all of which change without the event changing.
 */
export function incidentId({
  competitionType = null, gameId = null, sessionVersion = null,
  playOrdinal = null, type, frame = null, position = null, slot = null,
}) {
  return [
    competitionType ?? 'unknown',
    gameId ?? 'unknown',
    sessionVersion ?? 1,
    playOrdinal ?? 'unknown',
    type,
    frame ?? 'noframe',
    position ?? slot ?? 'noactor',
  ].join('/')
}

// ── the type table ──────────────────────────────────────────────────────────
//
// One row per canonical incident type. `capability` names the detector that has
// to have been RUNNING for an absence to mean "it did not happen": a capture
// recorded before that detector existed reports the type as unavailable rather
// than as zero. That distinction is the difference between "Mario Stadium has
// no barrels" and "this session could not have seen one".

const ACTOR_EFFECTS = [
  // [source array, canonical type, label, capability, default cause/confidence]
  ['freezes', 'player_freeze', 'Frozen', 'freeze_flag', 'freezie', CONFIDENCE.UNKNOWN],
  ['flower_sprays', 'flower_spray', 'Poison flower spray', 'flower_gas_flag', 'flower_gas', CONFIDENCE.FLAG_NAMED],
  ['dk_pow_stuns', 'dk_pow_stun', 'DK statue POW', 'impact_stun_flag', 'dk_pow', CONFIDENCE.FLAG_NAMED],
  ['table_stuns', 'table_stun', 'Table stun', 'impact_stun_flag', 'table', CONFIDENCE.INFERRED],
  ['pipe_stuns', 'pipe_stun', 'Pipe stun', 'impact_stun_flag', 'pipe', CONFIDENCE.OBJECT_CONFIRMED],
]

const BALL_INTERACTIONS = [
  ['arrow_redirects', 'arrow_redirect', 'Arrow redirect', 'arrow_step'],
  ['table_ball_contacts', 'table_rebound', 'Table rebound', 'table_contact'],
  ['pipe_transits', 'pipe_transit', 'Pipe transit', 'pipe_transit'],
  ['manhole_ball_strikes', 'manhole_rebound', 'Manhole rebound', 'manhole_strike'],
  ['train_ball_hits', 'train_ball_hit', 'Train ball hit', 'train_ball'],
  ['train_ball_captures', 'train_ball_capture', 'Train ball capture', 'train_ball'],
  ['freezie_ball_rebounds', 'freezie_rebound', 'Freezie rebound', 'freezie_objects'],
  ['frozen_fielder_ball_contacts', 'frozen_fielder_ball_contact', 'Ball off a frozen fielder', 'freeze_flag'],
]

const OBJECT_CHANGES = [
  ['freezie_breaks', 'freezie_break', 'Freezie broken', 'freezie_objects'],
  ['table_breaks', 'table_break', 'Table broken', 'table_objects'],
]

// A break caused by a player doing something on purpose. Kept apart from an
// incidental one because "cleared the object" is a MECHANIC and belongs in a
// player's mechanics line, while the batted ball breaking it is stadium luck.
const INTENTIONAL_CAUSES = new Set(['fielder_buddy_attack', 'thrown_ball', 'star_swing'])

/**
 * The confidence a knockdown's own provenance earns.
 *
 * The deriver records HOW it named each one, and those strings are the whole
 * evidence ladder: `train_position` compares the captured train object against
 * the floored fielder, while `fence_band` only says he went down near a wall.
 * 56 of the archive's 79 train knockdowns are the weaker kind, and the old
 * adapter emitted both as one indistinguishable "Train knockdown".
 */
function hazardConfidence(source, hazard) {
  switch (String(source || '')) {
    case 'train_position':
    case 'knockdown_during_piranha_transport':
      return CONFIDENCE.OBJECT_CONFIRMED
    case 'knockdown_flag_phases':
      return CONFIDENCE.FLAG_NAMED
    case 'fence_band':
    case 'distance_fallback':
      return CONFIDENCE.INFERRED
    default:
      break
  }
  if (!hazard) return CONFIDENCE.UNKNOWN
  // A manhole is named from a surveyed object position plus the knockdown flag;
  // a star swing from the game's own captain flag. Both are named, neither is
  // the object's live state.
  return CONFIDENCE.FLAG_NAMED
}

function actorRef(event = {}) {
  return {
    position: event.by || event.position || null,
    characterId: finite(event.character_id),
    characterName: event.character || null,
  }
}

function resolved(ref, resolveFielder) {
  if (!ref?.position) return { ...ref, playerId: null }
  const extra = resolveFielder(ref) || {}
  return {
    position: ref.position,
    // The DATABASE character id when the resolver produced one, and the
    // capture's own id never. They are different id spaces that overlap almost
    // perfectly -- see scripts/tracker_character_ids.mjs -- so an unresolved
    // character stays null instead of borrowing whoever sits at that id.
    characterId: finite(extra.characterId),
    characterName: ref.characterName || null,
    playerId: extra.playerId || null,
    trackerCharacterId: finite(ref.characterId),
    unresolved: finite(extra.characterId) == null,
  }
}

/**
 * Turn one derived play into canonical stadium incidents.
 *
 * Pure: no database, no clock, no randomness. `resolveFielder` maps a capture
 * position to the roster identity that owned it AT GAME TIME, which is what
 * keeps a later roster move from rewriting history.
 */
export function buildStadiumIncidents(play = {}, {
  park = null,
  timeOfDay = 'unknown',
  competitionType = null,
  gameId = null,
  sessionVersion = null,
  playOrdinal = null,
  fps = 59.94,
  resolveFielder = () => ({}),
  detectorVersion = STADIUM_INCIDENT_SCHEMA_VERSION,
} = {}) {
  const incidents = []
  const base = { competitionType, gameId, sessionVersion, playOrdinal }

  const push = ({ family, type, label, raw, capability, victim, initiator, cause, intentional }) => {
    const frame = eventFrame(raw, play, fps)
    incidents.push({
      schema_version: STADIUM_INCIDENT_SCHEMA_VERSION,
      id: incidentId({ ...base, type, frame, position: victim?.position ?? initiator?.position ?? null,
        slot: raw?.slot ?? null }),
      family,
      type,
      label,
      park,
      time_of_day: timeOfDay,
      frame,
      t: finite(raw?.t ?? raw?.start_t),
      duration_frames: finite(raw?.frames),
      duration_seconds: finite(raw?.seconds),
      victim: victim || null,
      initiator: initiator || null,
      cause: {
        type: cause?.type ?? null,
        confidence: cause?.confidence ?? CONFIDENCE.UNKNOWN,
        source: cause?.source ?? null,
        player_caused: Boolean(cause?.type && PLAYER_CAUSED.has(cause.type)),
      },
      intentional: Boolean(intentional),
      capability,
      detector_version: detectorVersion,
      evidence: compact(raw),
    })
  }

  for (const [field, type, label, capability, causeType, confidence] of ACTOR_EFFECTS) {
    for (const raw of list(play[field])) {
      // A freeze whose Freezie the capture never recorded is an effect with no
      // proven cause. The three sessions that DID capture the object array put
      // an ACTIVE Freezie 2.64-3.59u from the frozen fielder at all 24 onsets,
      // so where the evidence exists the cause is confirmed and where it does
      // not the freeze is still counted -- as a freeze of unknown cause.
      const proven = raw.cause_confidence || raw.freezie_distance_units != null
      push({
        family: FAMILY.ACTOR_EFFECT, type, label, raw, capability,
        victim: resolved(actorRef(raw), resolveFielder),
        cause: {
          type: causeType,
          confidence: raw.cause_confidence
            || (proven ? CONFIDENCE.OBJECT_CONFIRMED : confidence),
          source: raw.location_source || raw.source_byte || raw.cause_source || null,
        },
      })
    }
  }

  // Bowser Castle's two fires, already separated by the deriver against a
  // surveyed statue front. A burn it explicitly DISCARDED (the flag outlived a
  // side change, so its duration describes two different people) is kept as an
  // unusable measurement rather than dropped, because a vanished 468-frame burn
  // and a burn that never happened are not the same fact.
  for (const raw of list(play.fire_hazards)) {
    const hazard = canonicalHazard(raw?.hazard)
    push({
      family: FAMILY.ACTOR_EFFECT,
      type: hazard ? `${hazard}` : 'fire_unresolved',
      label: hazard === 'statue_fire' ? 'Statue fire'
        : hazard === 'falling_lava' ? 'Falling lava' : 'Unresolved fire',
      raw,
      capability: 'burned_flag',
      victim: resolved(actorRef(raw), resolveFielder),
      cause: {
        type: hazard,
        confidence: raw?.discarded ? CONFIDENCE.UNKNOWN
          : hazard ? CONFIDENCE.INFERRED : CONFIDENCE.UNKNOWN,
        source: raw?.discarded || 'statue_front_distance',
      },
    })
  }

  // The generic knockdown flag. Park-neutral by design: it says a fielder was
  // floored and never what floored him, so an unnamed one is emitted with an
  // unknown cause and counted. 46 of the archive's 199 are exactly that.
  for (const raw of list(play.knockdowns)) {
    const hazard = canonicalHazard(raw?.hazard)
    push({
      family: FAMILY.ACTOR_EFFECT,
      type: hazard ? `${hazard}_knockdown` : 'knockdown_unknown_cause',
      label: hazard ? `${hazard.replace(/_/g, ' ')} knockdown` : 'Knockdown, cause unknown',
      raw,
      capability: 'knockdown_flag',
      victim: resolved(actorRef(raw), resolveFielder),
      cause: {
        type: hazard,
        confidence: hazardConfidence(raw?.hazard_source, hazard),
        source: raw?.hazard_source || null,
      },
    })
  }

  // A barrel interval can reach several fielders; only an approach the game's
  // own knockdown flag confirmed is a hit. `hit_source` keeps the old distance
  // fallback distinguishable from the flag, which is the difference between a
  // measured hit and a radius somebody chose.
  for (const barrel of list(play.barrel_events)) {
    for (const approach of list(barrel?.approaches).filter((entry) => entry?.hit)) {
      push({
        family: FAMILY.ACTOR_EFFECT,
        type: 'barrel_knockdown',
        label: 'Barrel knockdown',
        raw: { ...approach, frame: approach.knocked_down_frame ?? approach.closest_frame },
        capability: 'barrel_object',
        victim: resolved(actorRef(approach), resolveFielder),
        cause: {
          type: 'barrel',
          confidence: approach.hit_source === 'knockdown_flag'
            ? CONFIDENCE.FLAG_NAMED : CONFIDENCE.INFERRED,
          source: approach.hit_source || null,
        },
      })
    }
  }

  // A captain's star effect that disabled somebody without flooring them. A
  // PLAYER action wearing a stadium byte: counted so "star effects suffered"
  // exists, and flagged player_caused so it can never enter stadium luck.
  for (const raw of list(play.star_swing_effects)) {
    push({
      family: FAMILY.ACTOR_EFFECT,
      type: `star_effect_${raw?.effect || 'unknown'}`,
      label: `Captain star effect (${raw?.effect || 'unknown'})`,
      raw,
      capability: 'star_swing_flag',
      victim: resolved(actorRef(raw), resolveFielder),
      cause: {
        type: 'star_swing',
        confidence: CONFIDENCE.FLAG_NAMED,
        source: raw?.flag || null,
      },
    })
  }

  for (const [field, type, label, capability] of BALL_INTERACTIONS) {
    for (const raw of list(play[field])) {
      // NO VICTIM. A redirected ball did not hit anybody, and inventing a
      // fielder for it is how a ball interaction becomes a fake injury.
      // `frozen_fielder_ball_contact` is the one that names an actor, and it
      // names him as the surface the ball met, not as a second freeze.
      const contactActor = field === 'frozen_fielder_ball_contacts'
        ? resolved(actorRef(raw), resolveFielder) : null
      push({
        family: FAMILY.BALL_INTERACTION, type, label, raw, capability,
        victim: null,
        initiator: contactActor,
        cause: {
          type: raw?.mechanism || null,
          confidence: raw?.cause_source === 'train_position'
            || raw?.location_source === 'captured_table_transform_at_ball_contact'
            ? CONFIDENCE.OBJECT_CONFIRMED
            : raw?.cause_source === 'kinematic_exclusion' ? CONFIDENCE.INFERRED
              : CONFIDENCE.FLAG_NAMED,
          source: raw?.cause_source || raw?.location_source || raw?.mechanism || null,
        },
      })
    }
  }

  for (const [field, type, label, capability] of OBJECT_CHANGES) {
    for (const raw of list(play[field])) {
      const cause = raw?.cause || {}
      const intentional = INTENTIONAL_CAUSES.has(String(cause.type || ''))
      push({
        family: FAMILY.OBJECT_CHANGE, type, label, raw, capability,
        victim: null,
        // Who cleared it, when the deriver named somebody. A batted ball has no
        // initiator, which is what separates stadium luck from a player
        // deliberately smashing the thing.
        initiator: cause.by
          ? resolved({ position: cause.by, character_id: cause.character_id, character: cause.character }, resolveFielder)
          : null,
        intentional,
        cause: {
          type: cause.type || 'unknown',
          confidence: cause.type && cause.type !== 'unknown'
            ? CONFIDENCE.OBJECT_CONFIRMED : CONFIDENCE.UNKNOWN,
          source: cause.source || null,
        },
      })
    }
  }

  // One play can produce the same physical event through two channels -- a
  // knockdown named a barrel AND the barrel interval's own approach. Collapsing
  // on the identity keeps the stronger record and refuses to count it twice.
  const seen = new Map()
  for (const incident of incidents) {
    const existing = seen.get(incident.id)
    if (!existing || rank(incident.cause.confidence) > rank(existing.cause.confidence)) {
      seen.set(incident.id, incident)
    }
  }
  return [...seen.values()]
}

function rank(confidence) {
  return { object_confirmed: 3, flag_named: 2, inferred: 1, unknown: 0 }[confidence] ?? 0
}

function compact(event = {}) {
  return Object.fromEntries(Object.entries({
    frame: finite(event.frame ?? event.start_frame),
    t: finite(event.t ?? event.start_t),
    frames: finite(event.frames),
    slot: event.slot ?? null,
    flag_value: finite(event.flag_value),
    phases: Array.isArray(event.phases) ? event.phases : null,
    hazard_source: event.hazard_source || null,
    hit_source: event.hit_source || null,
    cause_source: event.cause_source || null,
    location_source: event.location_source || null,
    mechanism: event.mechanism || null,
    outcome: event.outcome || null,
    phase: event.phase || null,
    discarded: event.discarded || null,
    pipe: event.pipe || null,
    entry_pipe: event.entry_pipe || null,
    exit_pipe: event.exit_pipe || null,
    distance_units: finite(event.distance_units),
    manhole_distance_units: finite(event.manhole_distance_units),
    train_distance_units: finite(event.train_distance_units),
    fence_inside_units: finite(event.fence_inside_units),
    closest_units: finite(event.closest_units),
    statue_front_distance_units: finite(event.statue_front_distance_units),
    freezie_distance_units: finite(event.freezie_distance_units),
    star_swing_captain: event.star_swing_captain || null,
    home_run_flag: finite(event.home_run_flag),
  }).filter(([, value]) => value != null))
}

// ── aggregation ─────────────────────────────────────────────────────────────

function emptyRow() {
  return {
    incidents: 0,
    distinctPlays: 0,
    durationFrames: 0,
    durationSeconds: 0,
    ballInteractions: 0,
    objectBreaks: 0,
    intentionalObjectClears: 0,
    starEffectsSuffered: 0,
    unknownCauseIncidents: 0,
    byType: {},
    byPark: {},
    byConfidence: { object_confirmed: 0, flag_named: 0, inferred: 0, unknown: 0 },
  }
}

/**
 * Did the stadium, rather than the fielder, decide this fielding opportunity?
 *
 * A ball interaction (table, arrow, pipe, manhole, train, Freezie) changed the
 * batted ball's path, so it voids the opportunity for every fielder on the
 * play. An actor effect -- a stun, freeze, knockdown, burn or a captain's star
 * effect -- voids it only for the fielder it hit. An object break changes
 * neither. Season game 2767's line drive off a Daisy Cruiser table was being
 * charged to the centre fielder as a missed catch.
 *
 * ONLY BEFORE THE FIRST TOUCH. A hazard that floors a fielder after he has the
 * ball did not decide the catch: three barrel/night knockdowns in games 2766
 * and 2768 landed 1-111 frames after the catch they would otherwise have voided.
 */
export function stadiumDecidedFielding(incidents = [], position = null, { firstTouchFrame = null } = {}) {
  const cutoff = finite(firstTouchFrame)
  return list(incidents).some((incident) => {
    const frame = finite(incident?.frame)
    if (cutoff != null && frame != null && frame >= cutoff) return false
    return incident?.family === FAMILY.BALL_INTERACTION
      || (incident?.family === FAMILY.ACTOR_EFFECT && position != null
        && String(incident?.victim?.position ?? '') === String(position))
  })
}

/**
 * Per-actor descriptive totals, by database player or character id.
 *
 * WHAT THIS COUNTS AND WHAT IT REFUSES TO. `incidents` is physical incidents
 * whose VICTIM is this actor -- never a luck touch, never both sides of one
 * event. `ballInteractions` and `objectBreaks` are credited to an identified
 * initiator only; a ball redirect with nobody behind it belongs to the play and
 * appears in no actor's line.
 *
 * QUARANTINED EVIDENCE IS REJECTED, matching the movement and arm summaries.
 * The old gimmick summary was the only one that did not, so a session the
 * ingester had already marked untrustworthy still reached the leaderboard. The
 * rejected rows stay in the play for diagnostics; they are simply not official.
 */
export function summarizeStadiumIncidents(trackingPlays = [], identity = 'player', {
  includeQuarantined = false,
} = {}) {
  const idField = identity === 'character' ? 'characterId' : 'playerId'
  const grouped = {}
  const plays = new Map()

  const ensure = (id) => {
    const key = String(id)
    if (!grouped[key]) grouped[key] = emptyRow()
    if (!plays.has(key)) plays.set(key, new Set())
    return [key, grouped[key]]
  }

  for (const play of trackingPlays || []) {
    if (!includeQuarantined && play?.quality?.quarantined_session === true) continue
    const playKey = String(play?.id ?? `${play?.competition_type}:${play?.game_id}:${play?.play_ordinal}`)
    for (const incident of list(play?.quality?.stadium_incidents)) {
      const actor = incident.family === FAMILY.ACTOR_EFFECT ? incident.victim : incident.initiator
      const id = actor?.[idField]
      if (id == null) continue
      const [key, row] = ensure(id)
      plays.get(key).add(playKey)
      row.byPark[incident.park || 'unknown'] = (row.byPark[incident.park || 'unknown'] || 0) + 1
      row.byType[incident.type] = (row.byType[incident.type] || 0) + 1
      row.byConfidence[incident.cause?.confidence] =
        (row.byConfidence[incident.cause?.confidence] || 0) + 1
      if (incident.cause?.confidence === CONFIDENCE.UNKNOWN) row.unknownCauseIncidents += 1

      if (incident.family === FAMILY.ACTOR_EFFECT) {
        row.incidents += 1
        if (incident.cause?.player_caused) row.starEffectsSuffered += 1
        row.durationFrames += finite(incident.duration_frames) ?? 0
        row.durationSeconds += finite(incident.duration_seconds) ?? 0
      } else if (incident.family === FAMILY.BALL_INTERACTION) {
        row.ballInteractions += 1
      } else if (incident.family === FAMILY.OBJECT_CHANGE) {
        row.objectBreaks += 1
        if (incident.intentional) row.intentionalObjectClears += 1
      }
    }
  }

  for (const [key, row] of Object.entries(grouped)) {
    row.distinctPlays = plays.get(key)?.size || 0
    row.durationSeconds = Number(row.durationSeconds.toFixed(4))
  }
  return grouped
}

/**
 * League-level totals, for the coverage panel.
 *
 * Counts each physical event ONCE. Never derived by summing a luck column:
 * every luck event credits one owner and debits another, so that sum is exactly
 * twice the number of events and reads as a doubling nobody notices.
 */
export function stadiumIncidentTotals(trackingPlays = [], { includeQuarantined = false } = {}) {
  const totals = {
    plays: 0, incidents: 0, actorEffects: 0, ballInteractions: 0, objectChanges: 0,
    unresolvedActors: 0, unknownCause: 0, byType: {}, byPark: {}, byConfidence: {},
  }
  for (const play of trackingPlays || []) {
    if (!includeQuarantined && play?.quality?.quarantined_session === true) continue
    const incidents = list(play?.quality?.stadium_incidents)
    if (incidents.length) totals.plays += 1
    for (const incident of incidents) {
      totals.incidents += 1
      totals.byType[incident.type] = (totals.byType[incident.type] || 0) + 1
      totals.byPark[incident.park || 'unknown'] = (totals.byPark[incident.park || 'unknown'] || 0) + 1
      const confidence = incident.cause?.confidence || CONFIDENCE.UNKNOWN
      totals.byConfidence[confidence] = (totals.byConfidence[confidence] || 0) + 1
      if (confidence === CONFIDENCE.UNKNOWN) totals.unknownCause += 1
      if (incident.family === FAMILY.ACTOR_EFFECT) {
        totals.actorEffects += 1
        if (incident.victim?.unresolved) totals.unresolvedActors += 1
      } else if (incident.family === FAMILY.BALL_INTERACTION) totals.ballInteractions += 1
      else if (incident.family === FAMILY.OBJECT_CHANGE) totals.objectChanges += 1
    }
  }
  return totals
}
