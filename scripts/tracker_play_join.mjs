// Attach a 60 Hz player-tracking play to the tracker at-bat it belongs to.
//
// These are two independent observations of the same event, made by two
// processes that never speak to each other: the tracker .exe reads the game's
// log and produces plate appearances, while the collector reads the game's
// memory sixty times a second and produces plays. Neither carries the other's
// identifier. Joining them is therefore inference, and the failure mode is
// specific and nasty -- a play attached to the wrong at-bat does not look like
// an error, it looks like a fielder who made a catch on a strikeout.
//
// So this never guesses. Every play comes back with one of five statuses and
// the reasons behind it, and a play that could plausibly belong to more than
// one at-bat is reported as ambiguous rather than attached to the nearest.
//
// WHAT LINES THE TWO UP. Inning, half, and batter are the coarse key. The
// count and outs are the discriminators. Count separates successive contacts
// inside one trip; outs separates repeat trips by the same batter in a long
// half-inning. Both feeds read outs directly, so leaving it out turned two
// seventh-inning Light Blue Yoshi contacts at 0-0 into an ambiguity even
// though one happened with no outs and the other with two.
//
// ONE AT-BAT, SEVERAL PLAYS. Fouls are batted balls. A four-pitch at-bat with
// three foul balls produces four plays and one plate appearance, so the join is
// many-to-one by design, and only the fair ball is the at-bat's outcome.

import { normalizeCharacterName, rosterCharacterName } from './tracker_character_ids.mjs'

export const JOIN_STATUSES = Object.freeze([
  'joined', 'pending', 'ambiguous', 'orphaned', 'mismatch',
])

// The game spells two characters differently from the roster, and the play
// stream uses the game's spelling while the tracker log uses the roster's.
const NAME_ALIASES = {
  koopatroopa: 'koopa',
  redkoopatroopa: 'redkoopa',
}

// The capture names every Mii plain "Mii"; the tracker log names the shirt,
// "Orange Mii (M)". Both fold to the roster's family name, or every Mii play is
// orphaned (both of Orange Mii's contacts in season game 2767 were).
function nameKey(value) {
  const normalized = normalizeCharacterName(rosterCharacterName(value))
  return NAME_ALIASES[normalized] || normalized
}

/** 'top' | 'bottom' from the collector's own inning_half byte. */
export function halfFromPlay(play) {
  if (play?.inning_half === 0) return 'top'
  if (play?.inning_half === 1) return 'bottom'
  return null
}

// Foul balls and fair balls are both plays, but only one of them can be the
// at-bat's outcome. Everything else about the join treats them identically.
export const FAIR_CLASSES = Object.freeze(
  new Set(['fair_in_play', 'fair_caught', 'home_run', 'home_run_robbed']),
)

export function isFairPlay(play) {
  return FAIR_CLASSES.has(play?.batted_ball_class)
}

// Every count this plate appearance actually passed through.
//
// BOTH ENDS OF EVERY PITCH, deliberately. The count a pitch STARTED at is the
// obvious half; the count it LEFT BEHIND is the other, and leaving it out cost
// a real lineout. The tracker samples the count at contact, before the game has
// applied the strike a foul ball produces, so a plate appearance that fouls one
// off and then puts the next pitch in play records both pitches as starting at
// the same count while the 60 Hz capture -- which reads the count a frame later
// -- correctly stamps the second batted ball one strike further on. Matching on
// start counts alone then rejects the fair ball as "a count this at-bat never
// saw" and leaves the at-bat holding the foul.
//
// This only ever adds counts the at-bat genuinely reached, so a play struck at
// a count nowhere in the plate appearance is still the mismatch it should be.
function countsSeen(atBat) {
  const counts = new Set()
  for (const pitch of atBat?.pitches || []) {
    counts.add(`${pitch.count_balls_before}-${pitch.count_strikes_before}`)
    if (pitch.count_balls_after != null && pitch.count_strikes_after != null) {
      counts.add(`${pitch.count_balls_after}-${pitch.count_strikes_after}`)
    }
  }
  // A plate appearance the tracker has not yet emitted a pitch for has seen
  // 0-0 and nothing else.
  if (!counts.size) counts.add('0-0')
  return counts
}

// Results that cannot possibly have a batted ball attached to them. Joining a
// fair ball to one of these is a contradiction rather than a near miss, and it
// is the single most useful thing this module can catch: it means either the
// at-bat or the play was misread.
const NO_CONTACT_RESULTS = new Set(['BB', 'HBP', 'K'])

/**
 * Join one play against the at-bats a session has produced so far.
 *
 * `atBats` are serialized preview at-bats (pa_number, inning, half,
 * batter_name, pitches, result). `latest` describes how far the tracker has
 * got, so a play that has simply overtaken the log is `pending` rather than
 * `orphaned` -- the difference between "not yet" and "never".
 */
export function joinPlayToAtBat(play, atBats = [], {
  latestInning = null, latestHalf = null, batterOccurrence = null,
} = {}) {
  const half = halfFromPlay(play)
  const batter = nameKey(play?.batter)
  const evidence = {
    contact_timer: play?.contact_timer ?? null,
    inning: play?.inning ?? null,
    half,
    batter: play?.batter ?? null,
    count: `${play?.balls ?? '?'}-${play?.strikes ?? '?'}`,
    outs: play?.outs ?? null,
    batted_ball_class: play?.batted_ball_class ?? null,
  }

  const candidates = atBats.filter((atBat) => (
    Number(atBat.inning) === Number(play?.inning)
    && atBat.half === half
    && nameKey(atBat.batter_name) === batter
    && batter !== ''
  ))

  if (!candidates.length) {
    // Has the tracker log even reached this point in the game? If the play is
    // at or past the newest at-bat the log has produced, the at-bat is still
    // coming; if the log is already past it, it never arrived.
    const behind = latestInning == null
      || Number(play?.inning) > Number(latestInning)
      || (Number(play?.inning) === Number(latestInning)
        && half === 'bottom' && latestHalf === 'top')
    return {
      status: behind ? 'pending' : 'orphaned',
      pa_number: null,
      candidate_pa_numbers: [],
      reason: behind
        ? 'the tracker log has not produced this at-bat yet'
        : 'no at-bat in this session matches this play’s inning, half and batter',
      evidence,
    }
  }

  const count = `${play?.balls}-${play?.strikes}`
  const byCount = candidates.filter((atBat) => countsSeen(atBat).has(count))
  const countCandidates = byCount.length ? byCount : candidates
  const playOuts = Number(play?.outs)
  const hasPlayOuts = Number.isInteger(playOuts) && playOuts >= 0 && playOuts <= 2
  const byOuts = hasPlayOuts
    ? countCandidates.filter((atBat) => atBat.outs_before_pa != null
      && Number(atBat.outs_before_pa) === playOuts)
    : []
  let narrowed = byOuts.length ? byOuts : countCandidates

  // COUNT AND OUTS ARE NOT ENOUGH WHEN A LINEUP BATS AROUND. The 2026-09-12
  // DK Jungle game sent 18 batters to the plate in the first inning. Nine of
  // those PAs had the same batter, count and outs as an earlier trip, so both
  // otherwise healthy plays were marked ambiguous.
  //
  // A whole-session join has one additional fact an isolated play does not:
  // chronology. Fair contact closes a PA, while any fouls immediately before
  // it belong to that PA. That makes the first group of contacts for a batter
  // their first PA in the half-inning, the second group their second, and so
  // on. `joinSession` supplies that zero-based occurrence. Keep the isolated
  // API conservative -- without it, the same two candidates remain ambiguous.
  const chronologicalCandidates = isFairPlay(play) || play?.batted_ball_class === 'foul'
    ? candidates.filter((atBat) => !NO_CONTACT_RESULTS.has(atBat.result))
    : candidates
  if (chronologicalCandidates.length > 1 && Number.isInteger(batterOccurrence)
    && batterOccurrence >= 0 && batterOccurrence < chronologicalCandidates.length) {
    const chronological = [...chronologicalCandidates]
      .sort((left, right) => Number(left.pa_number) - Number(right.pa_number))
    narrowed = [chronological[batterOccurrence]]
  }

  if (narrowed.length > 1) {
    return {
      status: 'ambiguous',
      pa_number: null,
      candidate_pa_numbers: narrowed.map((atBat) => atBat.pa_number),
      reason: byOuts.length > 1
        ? `${narrowed.length} at-bats in this half-inning match this batter, ${count} and ${playOuts} outs`
        : byCount.length > 1
        ? `${narrowed.length} at-bats in this half-inning match this batter and were at ${count}`
        : `${narrowed.length} at-bats match this batter and none of them saw ${count}`,
      evidence,
    }
  }

  const atBat = narrowed[0]
  const contradictions = []
  if (!countsSeen(atBat).has(count)) {
    contradictions.push(`the play was struck at ${count}, a count PA ${atBat.pa_number} never saw`)
  }
  if (hasPlayOuts && atBat.outs_before_pa != null
    && Number(atBat.outs_before_pa) !== playOuts) {
    contradictions.push(`the play had ${playOuts} outs, but PA ${atBat.pa_number} began with ${atBat.outs_before_pa}`)
  }
  if (isFairPlay(play) && NO_CONTACT_RESULTS.has(atBat.result)) {
    contradictions.push(`a fair batted ball cannot belong to a plate appearance scored ${atBat.result}`)
  }
  if (contradictions.length) {
    return {
      status: 'mismatch',
      pa_number: atBat.pa_number,
      candidate_pa_numbers: [atBat.pa_number],
      reason: contradictions.join('; '),
      evidence,
    }
  }

  return {
    status: 'joined',
    pa_number: atBat.pa_number,
    candidate_pa_numbers: [atBat.pa_number],
    reason: candidates.length > 1 && Number.isInteger(batterOccurrence)
      ? `matched PA ${atBat.pa_number} as this batter's appearance ${batterOccurrence + 1} in the half-inning`
      : byOuts.length
      ? `matched PA ${atBat.pa_number} on inning, half, batter, the ${count} count and ${playOuts} outs`
      : byCount.length
      ? `matched PA ${atBat.pa_number} on inning, half, batter and the ${count} count`
      : `matched PA ${atBat.pa_number} on inning, half and batter`,
    evidence,
  }
}

/**
 * Join a whole session at once, and pick each at-bat's decisive play.
 *
 * An at-bat's outcome play is its fair ball. Fouls stay attached -- they are
 * real batted balls with real fielding on them -- but they never become the
 * play the at-bat's narrative is built from, because the at-bat did not end on
 * one. Two fair balls on one at-bat is impossible and is reported rather than
 * resolved by picking the later.
 */
export function joinSession(plays = [], atBats = [], options = {}) {
  // Chronology is proof only when this play set accounts for every
  // contact-producing trip by that batter. A partial capture containing one
  // of two repeat trips cannot say whether it saw the first or second and must
  // remain ambiguous. Strikeouts, walks and HBP do not require a measured
  // batted ball and are excluded from the expected total.
  const fairTotals = new Map()
  for (const play of plays) {
    if (!isFairPlay(play)) continue
    const key = `${play?.inning}|${halfFromPlay(play)}|${nameKey(play?.batter)}`
    fairTotals.set(key, (fairTotals.get(key) || 0) + 1)
  }
  const contactPaTotals = new Map()
  for (const atBat of atBats) {
    if (NO_CONTACT_RESULTS.has(atBat?.result)) continue
    const key = `${atBat?.inning}|${atBat?.half}|${nameKey(atBat?.batter_name)}`
    contactPaTotals.set(key, (contactPaTotals.get(key) || 0) + 1)
  }
  const completedByBatter = new Map()
  const joins = plays.map((play) => {
    const key = `${play?.inning}|${halfFromPlay(play)}|${nameKey(play?.batter)}`
    const batterOccurrence = completedByBatter.get(key) || 0
    const chronologyComplete = fairTotals.get(key) === contactPaTotals.get(key)
    const entry = {
      play,
      join: joinPlayToAtBat(play, atBats, {
        ...options,
        batterOccurrence: chronologyComplete ? batterOccurrence : null,
      }),
    }
    // Fouls remain in the current appearance. Every fair class ends it, even
    // if the other feed later proves the result or join itself inconsistent.
    if (isFairPlay(play)) completedByBatter.set(key, batterOccurrence + 1)
    return entry
  })
  const byPa = new Map()
  for (const entry of joins) {
    if (entry.join.status !== 'joined') continue
    const list = byPa.get(entry.join.pa_number) || []
    list.push(entry)
    byPa.set(entry.join.pa_number, list)
  }
  const outcomes = new Map()
  for (const [paNumber, entries] of byPa) {
    const fair = entries.filter((entry) => isFairPlay(entry.play))
    if (fair.length === 1) {
      outcomes.set(paNumber, { play: fair[0].play, join: fair[0].join })
    } else if (fair.length > 1) {
      // Two fair balls in one plate appearance is not something to resolve by
      // preference; it means the join or the derivation is wrong.
      for (const entry of fair) {
        entry.join = {
          ...entry.join,
          status: 'ambiguous',
          reason: `PA ${paNumber} has ${fair.length} fair batted balls joined to it`,
        }
      }
    }
  }
  return {
    joins,
    outcomeByPaNumber: outcomes,
    tally: joins.reduce((totals, entry) => {
      totals[entry.join.status] = (totals[entry.join.status] || 0) + 1
      return totals
    }, {}),
  }
}
