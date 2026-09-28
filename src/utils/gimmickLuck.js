// Experimental stadium-gimmick luck.
//
// The 60 Hz deriver records evidence, not a counterfactual. We therefore do
// not pretend these points are runs or wins. Each independently confirmed
// stadium interaction is one zero-sum point between the two owners:
//
//   * a stadium effect that hinders a fielder favors the offense;
//   * a stadium redirect of the ball favors the side that won the play.
//
// Keeping the normalized events on tracking_plays.quality makes the ranking
// auditable without adding a second persistence tree. The raw capture remains
// the source of truth and can be re-derived/versioned through the existing
// tracking-session workflow.

import { FAMILY, canonicalHazard } from './stadiumIncidents.js'
import {
  baseStateMaskFromAssignments,
  baseStateMaskFromPa,
  normalizeRunnerAssignments,
  runExpectancyValue,
} from './advancedDefense.js'
import { calculateOutsForPa } from './defensiveEfficiency.js'

const OFFENSE_WON_RESULTS = new Set(['1B', '2B', '3B', 'HR', 'IPHR', 'ROE', 'FC'])

const DIRECT_FIELDER_EFFECTS = [
  ['frozen_fielder_ball_contacts', 'freezie_fielder_contact', 'Freezie-frozen fielder contact'],
  ['table_stuns', 'table_stun', 'Table stun'],
  ['pipe_stuns', 'pipe_stun', 'Pipe stun'],
  ['dk_pow_stuns', 'dk_pow_stun', 'DK statue POW'],
  ['flower_sprays', 'flower_spray', 'Poison flower spray'],
]

const BALL_EFFECTS = [
  ['freezie_ball_rebounds', 'freezie_rebound', 'Freezie rebound'],
  ['arrow_redirects', 'arrow_redirect', 'Arrow redirect'],
  ['table_ball_contacts', 'table_rebound', 'Table rebound'],
  ['pipe_transits', 'pipe_transit', 'Pipe transit'],
  ['manhole_ball_strikes', 'manhole_rebound', 'Manhole rebound'],
  ['train_ball_hits', 'train_ball_hit', 'Train ball hit'],
  ['train_ball_captures', 'train_ball_capture', 'Train ball capture'],
]

// KEYED ON THE CANONICAL NAME, because the producer's spelling and this list's
// disagreed and a whitelist miss is silent. The deriver writes
// `hazard: 'manhole_water'` and this map said 'manhole', so every one of the
// archive's 19 manhole knockdowns was discarded on the way to the site. The
// alias table in stadiumIncidents.js is now the single place the two vocabularies
// are reconciled.
const STADIUM_KNOCKDOWN_HAZARDS = new Map([
  ['barrel', 'Barrel knockdown'],
  ['manhole_water', 'Manhole knockdown'],
  ['piranha_plant', 'Piranha Plant knockdown'],
  ['train', 'Train knockdown'],
  ['bob_omb_bomb', 'Bob-omb knockdown'],
  ['falling_lava', 'Falling lava knockdown'],
  ['statue_fire', 'Statue fire knockdown'],
])

function list(value) {
  return Array.isArray(value) ? value : []
}

function finite(value) {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function compactEvidence(event = {}) {
  return Object.fromEntries(Object.entries({
    frame: finite(event.frame ?? event.start_frame),
    t: finite(event.t ?? event.start_t),
    source: event.source || event.hazard_source || event.cause_source || event.hit_source || event.location_source || null,
    mechanism: event.mechanism || null,
    hazard: event.hazard || null,
  }).filter(([, value]) => value != null))
}

function fielderReference(event = {}) {
  return {
    position: event.by || event.position || null,
    characterId: finite(event.character_id),
    characterName: event.character || null,
  }
}

function mergeIdentity(fallback, resolved = {}) {
  return {
    ...fallback,
    ...resolved,
    playerId: resolved.playerId || fallback?.playerId || null,
    characterId: finite(resolved.characterId) ?? finite(fallback?.characterId),
  }
}

function eventIdentity(event) {
  return [
    event.type,
    event.evidence?.frame ?? event.evidence?.t ?? '',
    event.affected_position || '',
    event.affected_character_id ?? '',
  ].join(':')
}

/**
 * Convert the deriver's park-specific arrays into a stable, site-facing event
 * contract. Generic freezes/knockdowns/stuns are intentionally absent unless
 * the deriver named a stadium cause; a detected effect with unknown causation
 * is not evidence of gimmick luck.
 */
export function buildGimmickEvents(play = {}, {
  plateAppearance = null,
  resolveFielder = () => ({}),
} = {}) {
  const pa = plateAppearance || {}
  const offenseWon = OFFENSE_WON_RESULTS.has(String(pa.result || '').toUpperCase())
  const offense = {
    playerId: pa.player_id || null,
    characterId: finite(pa.character_id),
  }
  const defense = {
    playerId: pa.pitcher_player_id || null,
    characterId: finite(pa.pitcher_id),
  }
  const primaryRef = fielderReference({
    by: play.primary_fielder || play.first_touch?.by,
    character_id: play.first_touch?.character_id,
    character: play.first_touch?.character,
  })
  const primary = mergeIdentity({
    playerId: defense.playerId,
    characterId: primaryRef.characterId,
  }, resolveFielder(primaryRef))
  const normalized = []

  const add = ({ type, label, category, raw, affected = null, forcedWinner = null }) => {
    const affectedResolved = affected
      ? mergeIdentity({ ...defense, ...affected }, resolveFielder(affected))
      : null
    const offenseBenefits = forcedWinner ? forcedWinner === 'offense'
      : category === 'fielder_hindered' ? true : offenseWon
    const winner = offenseBenefits ? offense : primary
    const loser = offenseBenefits ? (affectedResolved || primary) : offense
    normalized.push({
      schema_version: 1,
      type,
      label,
      category,
      beneficiary_side: offenseBenefits ? 'offense' : 'defense',
      beneficiary_player_id: winner.playerId || null,
      beneficiary_character_id: finite(winner.characterId),
      unlucky_player_id: loser.playerId || null,
      unlucky_character_id: finite(loser.characterId),
      affected_position: affectedResolved?.position || null,
      affected_character_id: finite(affectedResolved?.characterId),
      points: 1,
      evidence: compactEvidence(raw),
    })
  }

  for (const [field, type, label] of DIRECT_FIELDER_EFFECTS) {
    for (const raw of list(play[field])) {
      add({ type, label, category: 'fielder_hindered', raw, affected: fielderReference(raw) })
    }
  }

  for (const raw of list(play.fire_hazards)) {
    if (!raw?.hazard || raw.discarded) continue
    add({
      type: `fire_hazard_${raw.hazard}`,
      label: raw.hazard === 'statue_fire' ? 'Statue fire' : 'Falling lava',
      category: 'fielder_hindered', raw, affected: fielderReference(raw),
    })
  }

  for (const raw of list(play.knockdowns)) {
    const hazard = canonicalHazard(raw?.hazard) || ''
    if (!STADIUM_KNOCKDOWN_HAZARDS.has(hazard)) continue
    add({
      type: `${hazard}_knockdown`, label: STADIUM_KNOCKDOWN_HAZARDS.get(hazard),
      category: 'fielder_hindered', raw, affected: fielderReference(raw),
    })
  }

  // A barrel interval can contain several approaches; only the fielder hits
  // confirmed by the game's knockdown flag (or the old documented fallback)
  // are luck events.
  for (const barrel of list(play.barrel_events)) {
    for (const approach of list(barrel?.approaches).filter((entry) => entry?.hit)) {
      add({
        type: 'barrel_knockdown', label: 'Barrel knockdown',
        category: 'fielder_hindered',
        raw: { ...approach, frame: approach.knocked_down_frame ?? approach.closest_frame,
          source: approach.hit_source },
        affected: fielderReference(approach),
      })
    }
  }

  for (const [field, type, label] of BALL_EFFECTS) {
    for (const raw of list(play[field])) {
      add({
        type, label, category: 'ball_redirected', raw,
        forcedWinner: type === 'train_ball_capture' && play.home_run ? 'offense' : null,
      })
    }
  }

  // Breaking an object with the batted ball is itself a stadium interaction.
  // Throws, Buddy Attacks and star swings are player actions, so they remain
  // in the raw evidence but do not enter luck.
  for (const [field, type, label] of [
    ['freezie_breaks', 'freezie_break', 'Freezie broken by ball'],
    ['table_breaks', 'table_break', 'Table broken by ball'],
  ]) {
    for (const raw of list(play[field])) {
      const cause = String(raw?.cause?.type || '')
      if (cause !== 'batted_ball') continue
      add({ type, label, category: 'ball_redirected', raw })
    }
  }

  const seen = new Set()
  return normalized.filter((event) => {
    const key = eventIdentity(event)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ── stadium runs ────────────────────────────────────────────────────────────
//
// The points above say WHO the park favoured. Stadium runs say BY HOW MUCH:
// the run value of what happened minus what the same ball was worth had the
// park done nothing. "Had the park done nothing" is the catch model's
// probability, whose features are the first 12 frames after contact -- long
// before any table, arrow or pipe -- so it describes the ball the park never
// touched. Positive runs are runs the park gave the offense; the batter is
// credited them and the fielder who would have made the catch is charged them.
//
// Recorded in two steps. The ingest has the capture, so it records the facts
// (what the park did, the early flight, where each outfielder stood, who they
// were). The recompute has every plate appearance and the current catch model,
// so it scores and prices -- which is what lets a better model reprice every
// stored play without re-ingesting anything.

export const STADIUM_RUNS_SCHEMA_VERSION = 1

const OUTFIELD_POSITIONS = ['LF', 'CF', 'RF']

// The catch model was fitted on balls projected to land at least 1.05 s after
// contact, 48 u from home, inside the foul lines. It has never seen a grounder
// or an infield liner, so those are left unpriced rather than scored.
const CATCH_MODEL_RANGE = Object.freeze({ minSeconds: 1, minRadiusUnits: 45, maxAngleDeg: 45 })

/**
 * The incidents the PARK caused before the first touch. A ball interaction's
 * type names the object (table, arrow, pipe); an actor effect has to name its
 * cause, because a captain's star effect writes the same bytes as a hazard and
 * a knockdown with no measured cause is not evidence the park did anything.
 */
function stadiumIncidentsBeforeTouch(incidents, firstTouchFrame) {
  const cutoff = finite(firstTouchFrame)
  return list(incidents).filter((incident) => {
    if (![FAMILY.BALL_INTERACTION, FAMILY.ACTOR_EFFECT].includes(incident?.family)) return false
    if (incident.family === FAMILY.ACTOR_EFFECT
      && (incident.cause?.player_caused || !incident.cause?.type)) return false
    const frame = finite(incident.frame)
    return cutoff == null || frame == null || frame < cutoff
  })
}

// A ball interaction changed the ball for everyone; an actor effect only for
// the fielder it hit.
function decidedFor(incidents, position) {
  return list(incidents).some((incident) => incident.family === FAMILY.BALL_INTERACTION
    || (position != null && String(incident.victim_position ?? '') === String(position)))
}

function projectionInRange(features = {}) {
  const x = finite(features.projected_endpoint_x_units)
  const z = finite(features.projected_endpoint_z_units)
  const seconds = finite(features.projected_landing_seconds)
  if (x == null || z == null || seconds == null) return false
  const angle = Math.abs(Math.atan2(x, -z) * 180 / Math.PI)
  return seconds >= CATCH_MODEL_RANGE.minSeconds
    && Math.hypot(x, z) >= CATCH_MODEL_RANGE.minRadiusUnits
    && angle <= CATCH_MODEL_RANGE.maxAngleDeg
}

/**
 * The ingest half: the facts a stadium-runs price needs from the capture, or
 * null when the park did nothing to the play before the first touch.
 */
export function buildStadiumRunsInput(play = {}, {
  incidents = [],
  plateAppearance = null,
  park = null,
  resolveFielder = () => ({}),
} = {}) {
  const stadium = stadiumIncidentsBeforeTouch(incidents, play.first_touch?.frame)
  if (!stadium.length) return null
  const pa = plateAppearance || {}
  const flight = play.preoutcome_flight
  return {
    schema_version: STADIUM_RUNS_SCHEMA_VERSION,
    park,
    incidents: stadium.map((incident) => ({
      type: incident.type,
      family: incident.family,
      frame: finite(incident.frame),
      victim_position: incident.victim?.position || null,
    })),
    batter_player_id: pa.player_id || null,
    batter_character_id: finite(pa.character_id),
    defense_player_id: pa.pitcher_player_id || null,
    outs_before: finite(play.outs),
    observed: play.caught_in_flight ? 'caught' : 'not_caught',
    home_run: Boolean(play.home_run),
    primary_fielder: play.primary_fielder || null,
    preoutcome_flight: flight?.valid ? {
      projected_endpoint_x_units: finite(flight.features?.projected_endpoint_x_units),
      projected_endpoint_z_units: finite(flight.features?.projected_endpoint_z_units),
      projected_landing_seconds: finite(flight.features?.projected_landing_seconds),
    } : null,
    outfielders: Object.fromEntries(OUTFIELD_POSITIONS.flatMap((position) => {
      const row = play.fielders?.[position]
      if (!Array.isArray(row?.pitch_release_start)) return []
      const identity = resolveFielder({ position, characterId: finite(row.character_id) }) || {}
      return [[position, {
        start: row.pitch_release_start.map((value) => finite(value)),
        player_id: identity.playerId || null,
        character_id: finite(identity.characterId),
      }]]
    })),
  }
}

/**
 * Which outfielder the park took the ball from, and how often an average one
 * catches it. `scoreCatch(input)` is scripts/catch_probability_model.mjs
 * scoreCatchProbability, injected so this module stays loadable in the browser.
 */
export function scoreStadiumCatch(input = {}, scoreCatch = () => ({})) {
  if (input.home_run) return { reason: 'home_run' }
  const flight = input.preoutcome_flight
  if (!flight) return { reason: 'no_preoutcome_flight' }
  if (!projectionInRange(flight)) return { reason: 'outside_catch_model_range' }
  const scored = Object.entries(input.outfielders || {}).map(([position, row]) => ({
    position,
    ...(scoreCatch({ park: input.park, position, start: row.start, ...flight }) || {}),
  }))
  const priced = scored.filter((row) => finite(row.probability) != null)
  if (!priced.length) return { reason: scored.find((row) => row.reason)?.reason || 'no_fielder_start' }
  const best = priced.reduce((top, row) => (row.probability > top.probability ? row : top))
  // The park stunned somebody, but not the fielder the ball was going to.
  if (!decidedFor(input.incidents, best.position)) return { reason: 'park_missed_the_catcher' }
  const fielder = input.outfielders[best.position]
  return {
    reason: null,
    catch_probability: best.probability,
    fielder_position: best.position,
    fielder_player_id: fielder.player_id || input.defense_player_id || null,
    fielder_character_id: finite(fielder.character_id),
    model_version: best.model_version || null,
    // 'rejected' until the catch model passes its gates: the column is
    // experimental until then.
    model_status: best.model_status || null,
  }
}

// The batter to first and only forced runners moving up: the conservative
// guess at a hit the park prevented, until the league has enough uncaught
// outfield balls to say what one is really worth.
function forcedSingle(mask) {
  let runs = 0
  let next = mask
  if (next & 1) {
    if (next & 2) {
      if (next & 4) runs = 1
      next |= 4
    }
    next |= 2
  }
  return { mask: next | 1, runs }
}

/**
 * The recompute half: score the catch, then price the play against the
 * league's run expectancy. Returns the input with a `price` object; its `runs`
 * is null, with a reason, when the play cannot be priced.
 */
export function priceStadiumRuns(input, plateAppearance, expectancy, { scoreCatch = () => ({}) } = {}) {
  if (!input) return input
  const { price: _stale, ...facts } = input
  const refuse = (reason, extra = {}) => ({ ...facts, price: { ...extra, runs: null, reason } })
  const chance = scoreStadiumCatch(facts, scoreCatch)
  if (chance.reason) return refuse(chance.reason)
  if (!plateAppearance) return refuse('no_plate_appearance', chance)
  const assignments = normalizeRunnerAssignments(plateAppearance.runner_assignments)
  if (!assignments.length) return refuse('no_runner_assignments', chance)
  const outs = finite(facts.outs_before)
  if (outs == null || outs > 2) return refuse('no_outs_before', chance)

  const probability = chance.catch_probability
  const re = (o, mask) => (o >= 3 ? 0 : runExpectancyValue(expectancy, o, mask))
  const mask = baseStateMaskFromPa(plateAppearance)
  const before = re(outs, mask)
  const outsOnPlay = calculateOutsForPa(plateAppearance.result, plateAppearance.outs_on_play)
  const runsOnPlay = assignments.filter((row) => row.destination === 'home').length
  const actual = runsOnPlay + re(outs + outsOnPlay, baseStateMaskFromAssignments(assignments)) - before
  const catchValue = re(outs + 1, mask) - before
  const single = forcedSingle(mask)
  const singleValue = single.runs + re(outs, single.mask) - before
  // Only one branch was observed; the other is the estimate.
  const caught = facts.observed === 'caught'
  const expected = caught
    ? probability * actual + (1 - probability) * singleValue
    : probability * catchValue + (1 - probability) * actual
  return {
    ...facts,
    price: {
      ...chance,
      runs: actual - expected,
      actual_run_value: actual,
      unobserved_run_value: caught ? singleValue : catchValue,
      expected_run_value: expected,
    },
  }
}

function emptySummary() {
  return {
    luckScore: 0,
    luckyEvents: 0,
    unluckyEvents: 0,
    totalEvents: 0,
    affectedPlays: 0,
    gimmickTypes: [],
    luckRuns: 0,
    pricedPlays: 0,
  }
}

/** Aggregate normalized tracking-play events by owner or character. */
export function summarizeGimmickLuck(trackingPlays = [], identity = 'player') {
  const idField = identity === 'character' ? 'character_id' : 'player_id'
  const grouped = {}
  const touchedPlays = new Map()
  const types = new Map()

  const ensure = (id) => {
    const key = String(id)
    if (!grouped[key]) grouped[key] = emptySummary()
    if (!touchedPlays.has(key)) touchedPlays.set(key, new Set())
    if (!types.has(key)) types.set(key, new Set())
    return [key, grouped[key]]
  }

  for (const play of trackingPlays || []) {
    // QUARANTINED EVIDENCE IS NOT OFFICIAL, and this was the one summary that
    // did not say so. The movement, arm and catch-probability summaries all
    // reject a session the ingester flagged (pointers left the captured region,
    // or more than 2% of frames missed); luck did not, so a capture already
    // known to be untrustworthy still reached the leaderboard. The rows stay in
    // the play for diagnostics -- they are simply not counted here.
    if (play?.quality?.quarantined_session === true) continue
    const events = list(play?.quality?.gimmick_events)
    for (const event of events) {
      const points = Math.max(0, finite(event.points) ?? 1)
      const luckyId = event[`beneficiary_${idField}`]
      const unluckyId = event[`unlucky_${idField}`]
      if (luckyId != null) {
        const [key, row] = ensure(luckyId)
        row.luckScore += points
        row.luckyEvents += points
        row.totalEvents += points
        touchedPlays.get(key).add(String(play.id ?? `${play.game_id}:${play.play_ordinal}`))
        types.get(key).add(event.label || event.type)
      }
      if (unluckyId != null) {
        const [key, row] = ensure(unluckyId)
        row.luckScore -= points
        row.unluckyEvents += points
        row.totalEvents += points
        touchedPlays.get(key).add(String(play.id ?? `${play.game_id}:${play.play_ordinal}`))
        types.get(key).add(event.label || event.type)
      }
    }

    // Stadium runs: zero-sum between the batter and the fielder the park
    // took the ball from.
    const stadiumRuns = play?.quality?.stadium_runs
    const runs = finite(stadiumRuns?.price?.runs)
    if (runs == null) continue
    const playKey = String(play.id ?? `${play.game_id}:${play.play_ordinal}`)
    for (const [id, signed] of [
      [stadiumRuns[`batter_${idField}`], runs],
      [stadiumRuns.price[`fielder_${idField}`], -runs],
    ]) {
      if (id == null) continue
      const [key, row] = ensure(id)
      row.luckRuns += signed
      row.pricedPlays += 1
      touchedPlays.get(key).add(playKey)
    }
  }

  for (const [key, row] of Object.entries(grouped)) {
    row.affectedPlays = touchedPlays.get(key)?.size || 0
    row.gimmickTypes = [...(types.get(key) || [])].sort()
  }
  return grouped
}

export function formatGimmickLuckScore(value) {
  const number = finite(value)
  if (number == null) return '-'
  return number > 0 ? `+${number}` : String(number)
}

export function formatGimmickLuckRuns(value, pricedPlays = 1) {
  const number = finite(value)
  if (number == null || !pricedPlays) return '-'
  const text = number.toFixed(2)
  return number > 0 ? `+${text}` : text
}
