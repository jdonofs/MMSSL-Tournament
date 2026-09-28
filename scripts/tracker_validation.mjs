// Contradictions in what the tracker says about a plate appearance.
//
// The narrative makes an incorrect interpretation READABLE. These checks make a
// certain class of incorrect interpretation IMPOSSIBLE TO MISS, by naming the
// specific pair of facts that cannot both be true. They are not quality scores
// and they are not heuristics about whether a play looked unusual -- every one
// of them is a statement about two fields that directly disagree.
//
// A warning is never a reason to change the data. It is a reason to look, and
// to press "Something is wrong" if the operator agrees.

import {
  TRACKER_MEASURED_DISTANCE_SOURCES,
  trackerEndpointIsCoordinateReset,
} from './tracker_play_events.mjs'

const OUT_RESULTS = new Set(['K', 'GO', 'FO', 'LO', 'DP', 'TP', 'SF', 'SH'])
const NO_CONTACT_RESULTS = new Set(['K', 'BB', 'HBP'])
// Pitch-telemetry terminals that mean the bat met the ball. Both end on the
// contact frame; they differ only in which signal the tracker noticed first.
const CONTACT_TERMINALS = new Set(['contact', 'left_batting_state'])

const CONTACT_RESULTS = new Set([
  '1B', '2B', '3B', 'HR', 'IPHR', 'GO', 'FO', 'LO', 'DP', 'TP', 'SF', 'SH', 'FC', 'ROE',
])

export const WARNING_SEVERITIES = Object.freeze(['error', 'warning', 'info'])

function warn(list, { id, severity, title, detail, fields }) {
  list.push({ id, severity, title, detail, fields })
}

/** Count transitions that the rules of baseball forbid. */
function checkCount(warnings, atBat) {
  let previous = null
  for (const pitch of atBat.pitches || []) {
    const before = { balls: pitch.count_balls_before, strikes: pitch.count_strikes_before }
    const after = { balls: pitch.count_balls_after, strikes: pitch.count_strikes_after }
    if (previous && (before.balls !== previous.balls || before.strikes !== previous.strikes)) {
      warn(warnings, {
        id: `count-gap-${pitch.pitch_number_pa}`,
        severity: 'error',
        title: 'Impossible count transition',
        detail: `Pitch ${pitch.pitch_number_pa} starts at ${before.balls}-${before.strikes} `
          + `but the previous pitch left the count at ${previous.balls}-${previous.strikes}.`,
        fields: { pitch_number_pa: pitch.pitch_number_pa, before, previous },
      })
    }
    const ballStep = after.balls - before.balls
    const strikeStep = after.strikes - before.strikes
    if (ballStep < 0 || strikeStep < 0 || ballStep > 1 || strikeStep > 1
      || (ballStep === 1 && strikeStep === 1)) {
      warn(warnings, {
        id: `count-step-${pitch.pitch_number_pa}`,
        severity: 'error',
        title: 'Impossible count transition',
        detail: `Pitch ${pitch.pitch_number_pa} moves the count ${before.balls}-${before.strikes} `
          + `→ ${after.balls}-${after.strikes}, which no single pitch can do.`,
        fields: { pitch_number_pa: pitch.pitch_number_pa, before, after },
      })
    }
    if (after.balls > 4 || after.strikes > 3) {
      warn(warnings, {
        id: `count-range-${pitch.pitch_number_pa}`,
        severity: 'error',
        title: 'Count out of range',
        detail: `Pitch ${pitch.pitch_number_pa} leaves the count at ${after.balls}-${after.strikes}.`,
        fields: { pitch_number_pa: pitch.pitch_number_pa, after },
      })
    }
    previous = after
  }
}

/** Telemetry that belongs to a different pitch than the one it is attached to. */
function checkPitchTelemetry(warnings, atBat) {
  for (const pitch of atBat.pitches || []) {
    const telemetry = pitch.pitch_telemetry
    if (!telemetry) continue
    if (telemetry.pitchCounter != null
      && Number(telemetry.pitchCounter) !== Number(pitch.pitch_number_pa)) {
      warn(warnings, {
        id: `telemetry-pitch-${pitch.pitch_number_pa}`,
        severity: 'error',
        title: 'Pitch telemetry attached to the wrong pitch',
        detail: `Pitch ${pitch.pitch_number_pa} carries flight telemetry the tracker `
          + `counted as pitch ${telemetry.pitchCounter}.`,
        fields: { pitch_number_pa: pitch.pitch_number_pa, telemetry_counter: telemetry.pitchCounter },
      })
    }
    // A pitch the batter hit is measured to the moment of CONTACT, and the
    // game applies the strike a foul ball earns after that. So telemetry one
    // strike behind the pitch record on a contact pitch is two correct reads at
    // two different instants, not a contradiction -- it fired on ten of one
    // game's eleven telemetry warnings and buried the one that meant something.
    //
    // `left_batting_state` is the same instant under a different name: the
    // measurement ends because the ball left the batting state, which is what
    // the bat meeting it does. Every one of the five in the 2026-09-04 DK Jungle
    // session ends on a contact seq, and the one that reached a foul earned its
    // strike afterwards -- so the exemption covers it too, or a foul ball fires
    // a warning that says only that the game applies foul strikes late.
    // The log's `foul` result is itself definitive contact evidence. Older
    // provisional flight records can end early as `forward_z_ended` (only four
    // samples on Playroom PA 13, 2026-08-28), before the game applies the foul
    // strike. Requiring the provisional terminal to say contact turns those
    // two honest timestamps into a false telemetry-count warning.
    const contactStrikeLag = (CONTACT_TERMINALS.has(telemetry.terminal)
      || pitch.result === 'foul')
      && telemetry.countAfter
      && telemetry.countAfter.balls === pitch.count_balls_after
      && telemetry.countAfter.strikes === pitch.count_strikes_after - 1
    if (!contactStrikeLag && telemetry.countAfter
      && (telemetry.countAfter.balls !== pitch.count_balls_after
        || telemetry.countAfter.strikes !== pitch.count_strikes_after)) {
      warn(warnings, {
        id: `telemetry-count-${pitch.pitch_number_pa}`,
        severity: 'warning',
        title: 'Pitch telemetry disagrees with the count',
        detail: `Pitch ${pitch.pitch_number_pa} ends at ${pitch.count_balls_after}-${pitch.count_strikes_after}, `
          + `but its telemetry recorded ${telemetry.countAfter.balls}-${telemetry.countAfter.strikes}.`,
        fields: { pitch_number_pa: pitch.pitch_number_pa, telemetry_count: telemetry.countAfter },
      })
    }
    // A relief pitcher who entered mid-count leaves earlier pitches measured for
    // the pitcher they replaced. Those are two correct reads at two different
    // instants, so the check is against every pitcher the plate appearance
    // faced rather than only the one it ended with.
    const pitchersFaced = atBat.pitchers_faced?.length
      ? atBat.pitchers_faced
      : [atBat.pitcher_name]
    if (telemetry.pitcherName && atBat.pitcher_name
      && telemetry.pitcherName !== 'unknown' && !pitchersFaced.includes(telemetry.pitcherName)) {
      warn(warnings, {
        id: `telemetry-pitcher-${pitch.pitch_number_pa}`,
        severity: 'error',
        title: 'Pitch telemetry names a different pitcher',
        detail: `Pitch ${pitch.pitch_number_pa} was measured for ${telemetry.pitcherName}, `
          + `but this plate appearance is against ${atBat.pitcher_name}.`,
        fields: {
        telemetry_pitcher: telemetry.pitcherName,
        pa_pitcher: atBat.pitcher_name,
        pitchers_faced: pitchersFaced,
      },
      })
    }
  }
}

/** Contact facts that the plate appearance's own result contradicts. */
function checkContact(warnings, atBat, play) {
  const result = atBat.result
  const hasContact = Boolean(atBat.advanced_batted_ball_raw) || Boolean(atBat.trajectory)
  const inPlayPitch = (atBat.pitches || []).some((pitch) => pitch.result === 'in_play')
  const hasStarSwingPitchFlags = (atBat.pitches || []).some(
    (pitch) => Object.hasOwn(pitch, 'is_star_swing'),
  )
  const starSwingPitches = (atBat.pitches || []).filter((pitch) => pitch.is_star_swing)

  if (atBat.star_hit_used && hasStarSwingPitchFlags && !starSwingPitches.length) {
    warn(warnings, {
      id: 'star-swing-without-pitch',
      severity: 'error',
      title: 'Star swing is not attached to a pitch',
      detail: 'The tracker announced a star swing, but no pitch in this plate appearance carries it.',
      fields: { star_hit_used: true, pitch_count: (atBat.pitches || []).length },
    })
  }
  if (atBat.star_hit_connected && !starSwingPitches.some((pitch) => pitch.result === 'in_play')) {
    warn(warnings, {
      id: 'star-contact-without-in-play-pitch',
      severity: 'error',
      title: 'Star contact is attached to the wrong pitch',
      detail: 'The plate appearance says the deciding contact was star-powered, but no starred pitch was put in play.',
      fields: { star_hit_connected: true, star_pitch_results: starSwingPitches.map((pitch) => pitch.result) },
    })
  }

  if (hasContact && result && NO_CONTACT_RESULTS.has(result)) {
    warn(warnings, {
      id: 'contact-without-in-play',
      severity: 'error',
      title: 'Contact recorded on a plate appearance with no ball in play',
      detail: `The tracker measured a batted ball, but the result is ${result}.`,
      fields: { result, trajectory: atBat.trajectory, batted_ball: Boolean(atBat.advanced_batted_ball_raw) },
    })
  }
  if (hasContact && !inPlayPitch && result && CONTACT_RESULTS.has(result)) {
    warn(warnings, {
      id: 'contact-without-in-play-pitch',
      severity: 'warning',
      title: 'Batted ball with no in-play pitch',
      detail: 'A batted ball was measured, but no pitch in this plate appearance is recorded as put in play.',
      fields: { result, pitch_results: (atBat.pitches || []).map((pitch) => pitch.result) },
    })
  }

  const record = atBat.advanced_batted_ball_raw
  // The executable read the ball on the frame the game blanked its coordinate,
  // so the endpoint it recorded is the origin. The position shown comes from
  // the 60 Hz capture instead; this says so rather than letting a silent
  // substitution look like the executable got it right.
  if (trackerEndpointIsCoordinateReset(record)) {
    warn(warnings, {
      id: 'endpoint-coordinate-reset',
      severity: 'warning',
      title: 'Endpoint is the dead-ball coordinate reset',
      detail: `The ${record.endpoint} endpoint was recorded at (${[record.x, record.y, record.z]
        .map((value) => Math.round(Number(value) * 100) / 100).join(', ')}), where the game parks `
        + 'a dead ball, not a place the ball was. The position comes from the 60 Hz capture.',
      fields: {
        endpoint: record.endpoint,
        endpoint_seq: record.endpointSeq ?? null,
        distance_feet: record.distanceFeet ?? null,
        hit_distance_ft: atBat.hit_distance_ft ?? null,
      },
    })
  }
  if (record && !record.endpoint && !record.endpointStatus) {
    warn(warnings, {
      id: 'batted-ball-unresolved-endpoint',
      severity: 'warning',
      title: 'Batted ball with no endpoint and no unresolved status',
      detail: 'The measurement has neither a resolved endpoint nor an explicit statement that it is unresolved.',
      fields: { endpoint: record.endpoint ?? null, endpoint_status: record.endpointStatus ?? null },
    })
  }

  // Measured and projected are different claims and must not be presented as
  // each other.
  const projection = atBat.preview_projection
  if (projection) {
    const claimsMeasured = TRACKER_MEASURED_DISTANCE_SOURCES.has(projection.distance_source)
    if (claimsMeasured && projection.is_projected) {
      warn(warnings, {
        id: 'projection-flag-disagrees',
        severity: 'error',
        title: 'Measured distance flagged as projected',
        detail: `distance_source is ${projection.distance_source} but is_projected is true.`,
        fields: { distance_source: projection.distance_source, is_projected: projection.is_projected },
      })
    }
    if (!claimsMeasured && projection.is_projected === false) {
      warn(warnings, {
        id: 'projection-flag-disagrees-2',
        severity: 'error',
        title: 'Projected distance presented as measured',
        detail: `distance_source is ${projection.distance_source} but is_projected is false.`,
        fields: { distance_source: projection.distance_source, is_projected: projection.is_projected },
      })
    }
  }

  if (!play) return
  const events = play.fielding_events || []
  for (const event of events) {
    if (event.secured && event.ball_contact !== 'confirmed') {
      warn(warnings, {
        id: `possession-without-contact-${event.frame}`,
        severity: 'error',
        title: 'Possession without contact',
        detail: `${event.character || event.by} is recorded as securing the ball with ball_contact = ${event.ball_contact}.`,
        fields: { by: event.by, ball_contact: event.ball_contact, secured: event.secured },
      })
    }
    if (event.fielding_attempt && event.ball_contact == null) {
      warn(warnings, {
        id: `attempt-without-classification-${event.frame}`,
        severity: 'warning',
        title: 'Fielding attempt with no contact classification',
        detail: `${event.character || event.by} has an attempt with no ball_contact value at all.`,
        fields: { by: event.by, event },
      })
    }
    // A physical failure to hold the ball is not the scorer's ruling.
    if (event.official_error === true && !atBat.is_error) {
      warn(warnings, {
        id: `error-inferred-${event.frame}`,
        severity: 'error',
        title: 'Official error asserted without scoring evidence',
        detail: 'A fielding event claims an official error that the plate appearance does not charge.',
        fields: { by: event.by, official_error: event.official_error, pa_is_error: atBat.is_error },
      })
    }
  }

  // The preview serializer normally discards this shared-animation false
  // signal once the capture proves there was no contact. Keep this check at
  // the validation boundary so another producer (or a regression that exposes
  // the raw announcement as a bobble again) cannot pass inconsistent data.
  const bobbler = atBat.fielding_events?.bobble
  if (bobbler) {
    const attempts = events.filter((event) => event.character === bobbler
      && event.event_type !== 'possession')
    if (attempts.length && attempts.every((event) => event.ball_contact === 'missed')) {
      warn(warnings, {
        id: 'bobble-without-contact',
        severity: 'warning',
        title: 'Announced bobble with no measured contact',
        detail: `The tracker announced a bobble by ${bobbler}, but the 60 Hz capture recorded `
          + 'no contact with the ball on any of their attempts.',
        fields: {
          bobble: bobbler,
          attempts: attempts.map((event) => ({
            t: event.t,
            ball_contact: event.ball_contact,
            contact_source: event.contact_source,
            closest_reach_units: event.closest_reach_units ?? null,
            within_reach: event.within_reach ?? null,
          })),
        },
      })
    }
  }

  // EXTRA BASES THAT FOLLOWED A BOOT. The operator, 2026-09-10 PA99: "this one
  // should be a single e9... yellow pianta booting it resulted in an extra two
  // bases, which should not be credited for a triple, rather single and
  // advanced 2 bases on the error."
  //
  // The scorer's rule is already settled -- an error erases the hit only when it
  // is why the batter REACHED, and otherwise it is charged for the advance -- so
  // what was missing is the tracker noticing that this is one of those plays.
  // This does NOT re-score anything: deciding the batter would have been held is
  // a judgement, and the capture only supplies the two facts it turns on. The
  // boot happening BEFORE the batter reached first is what makes the extra bases
  // arguable; a boot after he was already standing on second explains nothing.
  // AFTER THE LANDING, which is what makes it a boot rather than a ball going
  // past somebody. Without that clause this fired on two more plays in the same
  // game and both were the other thing: a ball still in flight brushing the 1B
  // at y=1.55 on its way to the outfield, and a ball whose "deflection" was its
  // own landing frame at the 3B's feet. Neither fielder ever had it to lose. The
  // real boot's ball was 0.59u from the glove and already on the ground.
  const EXTRA_BASE_HITS = new Set(['2B', '3B'])
  const boot = (play.deflections || []).find(
    (event) => event.ball_contact === 'confirmed' && event.secured === false
      && play.landing && Number(event.t) > Number(play.landing.t))
  const batterBases = Number(play.runners?.BAT?.bases_ran ?? 0)
  if (boot && EXTRA_BASE_HITS.has(atBat.result) && batterBases > 1
      && Number.isFinite(Number(play.home_to_first_s))
      && Number.isFinite(Number(boot.t))
      && Number(boot.t) <= Number(play.home_to_first_s)) {
    warn(warnings, {
      id: `extra-bases-after-boot-${boot.frame}`,
      severity: 'warning',
      title: 'Extra bases were taken after a measured boot',
      detail: `The plate appearance is credited as a ${atBat.result}, but `
        + `${boot.character || boot.by} contacted the ball at t=${boot.t}s and did not secure it, `
        + `which is before the batter reached first at t=${play.home_to_first_s}s. The batter took `
        + `${batterBases} bases. If the boot is why he got past first, the scoring is a single plus `
        + `${batterBases - 1} base${batterBases - 1 === 1 ? '' : 's'} on the error, not a `
        + `${atBat.result}.`,
      fields: {
        result: atBat.result,
        by: boot.by,
        character: boot.character ?? null,
        boot_t: boot.t,
        home_to_first_s: play.home_to_first_s,
        batter_bases_ran: batterBases,
        recovered_t: (play.possession_carries || [])[0]?.start_t ?? null,
      },
    })
  }

  if (play.caught_in_flight && play.landing) {
    warn(warnings, {
      id: 'catch-after-landing',
      severity: 'error',
      title: 'Catch recorded after a confirmed landing',
      detail: `The ball is recorded as caught in flight and as having landed at t=${play.landing.t}s.`,
      fields: { caught_in_flight: true, landing: play.landing },
    })
  }
}

/** Putouts and assists that are not in the possession/throw chain. */
function checkChain(warnings, atBat, play) {
  if (!play) return
  for (const throwRecord of play.throws || []) {
    if (throwRecord.throwing_error_candidate !== true) continue
    // This is now a charge the console made on its own, not a question it is
    // asking. It stays visible at `info` so the operator can still annotate it
    // away -- an automatic error that never surfaces is the one that gets into
    // the statistics unnoticed.
    warn(warnings, {
      id: `throwing-error-charged-${throwRecord.sequence}`,
      severity: 'info',
      title: 'Throwing error charged from measurement',
      detail: `An inaccurate throw pulled the receiver off ${throwRecord.target_base || 'the base'} while a runner `
        + 'arrived and no out was recorded, so an error is charged to the thrower. Flag the play if the scorer disagrees.',
      fields: {
        sequence: throwRecord.sequence,
        target_base: throwRecord.target_base,
        thrower_position: throwRecord.thrower_position,
        thrower_character: throwRecord.thrower_character,
        receiver_distance_from_target_units: throwRecord.receiver_distance_from_target_units,
        runner_at_arrival: throwRecord.runner_at_arrival,
      },
    })
  }
  const putouts = atBat.fielding_events?.putouts || []
  if (!putouts.length) return
  const chain = new Set()
  // A fielder the capture could only identify by id -- every Mii -- reaches
  // the chain under the tracker log's name for them, or this fires on every
  // putout a Mii records while naming a contradiction that is only a missing
  // entry in the game's character table.
  const add = (character, position) => {
    if (character) chain.add(character)
    const announced = position ? atBat.fielding_alignment?.[position] : null
    if (announced) chain.add(announced)
  }
  add(play.first_touch?.character, play.first_touch?.by)
  for (const throwRecord of play.throws || []) {
    add(throwRecord.thrower_character, throwRecord.thrower_position)
    add(throwRecord.receiver_character, throwRecord.receiver_position)
  }
  for (const event of play.fielding_events || []) {
    add(event.character, event.by)
  }
  if (!chain.size) return
  for (const putout of putouts) {
    if (putout.fielderName && !chain.has(putout.fielderName)) {
      warn(warnings, {
        id: `putout-outside-chain-${putout.fielderName}`,
        severity: 'warning',
        title: 'Putout outside the possession and throw chain',
        detail: `${putout.fielderName} is credited with a putout but never held or received the ball `
          + 'in the 60 Hz capture.',
        fields: { putout, chain: [...chain] },
      })
    }
  }
}

/** Runners who vanish, duplicate, or disagree with the recorded outs and runs. */
function checkRunners(warnings, atBat) {
  const assignments = atBat.runner_assignments
  const before = atBat.runners_before || {}
  const occupied = ['first', 'second', 'third'].filter((base) => before[base])

  // Checked before the assignments guard below, deliberately. An out result
  // that records no outs is a contradiction between two fields that are always
  // present, and gating it on runner assignments -- which are frequently
  // unresolved -- would silence it exactly when the at-bat is least trustworthy.
  if (atBat.result && OUT_RESULTS.has(atBat.result) && Number(atBat.outs_on_play || 0) === 0) {
    warn(warnings, {
      id: 'out-result-no-outs',
      severity: 'error',
      title: 'Out result with no outs on the play',
      detail: `The plate appearance is scored ${atBat.result} but records zero outs.`,
      fields: { result: atBat.result, outs_on_play: atBat.outs_on_play ?? 0 },
    })
  }

  if (!assignments) {
    if (atBat.result && occupied.length) {
      warn(warnings, {
        id: 'runners-unresolved',
        severity: 'warning',
        title: 'Runner assignments unresolved',
        detail: `${occupied.length} runner(s) were on base and the tracker did not resolve where they finished.`,
        fields: { runners_before: before },
      })
    }
    return
  }

  const destinations = new Map()
  for (const assignment of assignments) {
    const name = assignment.runner?.characterName
    if (!name) continue
    if (!assignment.destination) {
      warn(warnings, {
        id: `runner-no-destination-${name}`,
        severity: 'error',
        title: 'Runner disappears without a destination',
        detail: `${name} left ${assignment.origin} and is not recorded as safe, out, or scored.`,
        fields: { assignment },
      })
      continue
    }
    if (destinations.has(name) && destinations.get(name) !== assignment.destination) {
      warn(warnings, {
        id: `runner-two-destinations-${name}`,
        severity: 'error',
        title: 'Runner occupies two destinations',
        detail: `${name} is recorded as finishing at both ${destinations.get(name)} and ${assignment.destination}.`,
        fields: { runner: name, destinations: [destinations.get(name), assignment.destination] },
      })
    }
    destinations.set(name, assignment.destination)
  }

  // Two different runners cannot end on the same base.
  const byBase = new Map()
  for (const [name, destination] of destinations) {
    if (destination === 'out' || destination === 'home') continue
    if (byBase.has(destination)) {
      warn(warnings, {
        id: `base-shared-${destination}`,
        severity: 'error',
        title: 'Two runners on one base',
        detail: `${byBase.get(destination)} and ${name} both finish at ${destination}.`,
        fields: { base: destination, runners: [byBase.get(destination), name] },
      })
    }
    byBase.set(destination, name)
  }

  const outs = [...destinations.values()].filter((value) => value === 'out').length
  const scored = [...destinations.values()].filter((value) => value === 'home').length
  const declaredOuts = Number(atBat.outs_on_play || 0)
  const declaredRuns = (atBat.runs_scored || []).length
  if (atBat.result && outs !== declaredOuts) {
    warn(warnings, {
      id: 'outs-disagree',
      severity: 'error',
      title: 'Runner outcomes disagree with the recorded outs',
      detail: `${outs} runner(s) are recorded as retired, but the plate appearance records `
        + `${declaredOuts} out(s) on the play.`,
      fields: { runner_outs: outs, outs_on_play: declaredOuts, result: atBat.result },
    })
  }
  if (atBat.result && scored !== declaredRuns) {
    warn(warnings, {
      id: 'runs-disagree',
      severity: 'error',
      title: 'Runner outcomes disagree with the recorded runs',
      detail: `${scored} runner(s) are recorded as scoring, but ${declaredRuns} run row(s) exist.`,
      fields: { runner_runs: scored, runs_scored: declaredRuns, result: atBat.result },
    })
  }
}

/** The join itself, which is the one inference in the whole pipeline. */
function checkJoin(warnings, atBat, join) {
  if (!join) return
  if (join.status === 'ambiguous') {
    warn(warnings, {
      id: 'join-ambiguous',
      severity: 'error',
      title: 'Player-tracking play is not joined to exactly one at-bat',
      detail: join.reason || 'More than one at-bat could own this play.',
      fields: join,
    })
  }
  if (join.status === 'orphaned') {
    warn(warnings, {
      id: 'join-orphaned',
      severity: 'warning',
      title: 'Player-tracking play matches no at-bat',
      detail: join.reason || 'No at-bat in this session matches this play.',
      fields: join,
    })
  }
  if (join.status === 'mismatch') {
    warn(warnings, {
      id: 'join-mismatch',
      severity: 'error',
      title: 'Player-tracking play contradicts the at-bat it matches',
      detail: join.reason || 'The play and the at-bat disagree.',
      fields: join,
    })
  }
  if (join.status === 'pending' && atBat.result) {
    warn(warnings, {
      id: 'join-pending',
      severity: 'info',
      title: 'No player-tracking play yet',
      detail: 'This at-bat has finished and no 60 Hz play has been attached to it.',
      fields: join,
    })
  }
}

/** A live play and its postgame restatement that do not say the same thing. */
function checkDerivationAgreement(warnings, play, postgamePlay) {
  if (!play || !postgamePlay) return
  const compare = [
    'batted_ball_class', 'caught_in_flight', 'primary_fielder',
    'primary_fielder_reason', 'hang_time_s', 'home_to_first_s', 'truncated',
  ]
  for (const key of compare) {
    if (JSON.stringify(play[key]) !== JSON.stringify(postgamePlay[key])) {
      warn(warnings, {
        id: `derivation-disagrees-${key}`,
        severity: 'error',
        title: 'Live and postgame derivations disagree',
        detail: `${key}: live ${JSON.stringify(play[key])}, postgame ${JSON.stringify(postgamePlay[key])}.`,
        fields: { key, live: play[key], postgame: postgamePlay[key] },
      })
    }
  }
}

// Statuses that license a sentence saying an ability was USED. 'standard' is
// one of them: the game announced the star and the roster's name for a
// non-captain's star IS 'Standard', so naming it is reporting, not guessing.
const LICENSED_ABILITY_STATUSES = new Set(['confirmed', 'standard'])

// Sentences that contain "used" without naming an ability -- an unresolved
// special action, or a caveat that explicitly withholds the name.
const ABILITY_CLAIM_EXCLUSIONS = /not confirmed|does not name|unresolved special|every character can do/

/** An ability named as used without activation evidence behind it. */
function checkAbilityClaims(warnings, narrative) {
  for (const clause of narrative?.clauses || []) {
    // Any clause carrying an ability resolution is policed, not only the ones
    // filed under 'ability'. The approach clause names an ability too, and a
    // check that only looked at one category would have let it say anything.
    const resolution = clause.category === 'ability'
      ? (clause.evidence || {})
      : (clause.evidence?.ability_resolution || null)
    if (!resolution) continue
    const claimsUse = /\buse[sd]\b/.test(clause.text) && !ABILITY_CLAIM_EXCLUSIONS.test(clause.text)
    if (claimsUse && !LICENSED_ABILITY_STATUSES.has(resolution.status)) {
      warn(warnings, {
        id: `ability-claimed-${clause.id}`,
        severity: 'error',
        title: 'Ability claimed without activation evidence',
        detail: `"${clause.text}" asserts an ability was used, but its resolution status is `
          + `${resolution.status || 'missing'}.`,
        fields: { clause_id: clause.id, resolution },
      })
    }
    if (resolution.status === 'mismatch') {
      warn(warnings, {
        id: `ability-mismatch-${clause.id}`,
        severity: 'error',
        title: 'Observed ability disagrees with the character mapping',
        detail: `Observed ${resolution.observedAbilityName}, but this character maps to `
          + `${resolution.mappedAbility || 'no ability'}.`,
        fields: { clause_id: clause.id, resolution },
      })
    }
  }
}

/**
 * Every contradiction visible in one at-bat, its joined play, and the
 * narrative built from them. Ordered most severe first.
 */
export function validateTrackerAtBat({
  atBat = null, play = null, join = null, narrative = null, postgamePlay = null,
} = {}) {
  if (!atBat) return []
  const warnings = []
  checkCount(warnings, atBat)
  checkPitchTelemetry(warnings, atBat)
  checkContact(warnings, atBat, play)
  checkChain(warnings, atBat, play)
  checkRunners(warnings, atBat)
  checkJoin(warnings, atBat, join)
  checkDerivationAgreement(warnings, play, postgamePlay)
  checkAbilityClaims(warnings, narrative)
  const rank = { error: 0, warning: 1, info: 2 }
  return warnings.sort((a, b) => rank[a.severity] - rank[b.severity])
}

// --- the four-category verdict the history strip and the cards share --------
//
// One line per at-bat has room for four characters, so the rule behind each of
// them has to be worth that space. Each category answers the same question:
// is there anything here an operator would want to look at? `ok` means every
// fact this category needs was resolved; `warn` means something is missing,
// unresolved or contradicted; `missing` means the category produced nothing at
// all; `n/a` means it could not apply (there is no fielding on a walk).

// Out of the park only. An inside-the-park home run is fielded like any other
// ball in play and has to be judged on its fielding, not excused from it.
const HOME_RUN_RESULTS = new Set(['HR'])

const CONTACT_RESULT_SET = new Set([
  '1B', '2B', '3B', 'HR', 'IPHR', 'GO', 'FO', 'LO', 'DP', 'TP', 'SF', 'SH', 'FC', 'ROE',
])

export function summarizeAtBatChecks({ atBat, play = null, join = null, warnings = [] } = {}) {
  if (!atBat) return null
  const severity = (prefixes) => warnings.some(
    (warning) => warning.severity === 'error'
      && prefixes.some((prefix) => warning.id.startsWith(prefix)),
  )
  const pitches = atBat.pitches || []
  const hasContact = CONTACT_RESULT_SET.has(atBat.result)

  const pitching = !pitches.length
    ? (atBat.result ? 'missing' : 'pending')
    : severity(['count-', 'telemetry-']) ? 'warn'
      : pitches.some((pitch) => !pitch.pitch_telemetry) ? 'warn'
        : 'ok'

  const batting = !atBat.result ? 'pending'
    : !hasContact ? 'ok'
      : severity(['contact-', 'projection-']) ? 'warn'
        : (atBat.exit_velocity_mph == null || atBat.launch_angle_deg == null
          || atBat.hit_distance_ft == null || !atBat.trajectory) ? 'warn'
          : 'ok'

  let fielding
  if (!atBat.result) fielding = 'pending'
  else if (!hasContact) fielding = 'n/a'
  else if (!play || join?.status !== 'joined') fielding = 'warn'
  else if (severity(['possession-', 'attempt-', 'error-', 'catch-', 'putout-', 'join-'])) fielding = 'warn'
  else if ((play.fielding_events || []).some((event) => event.ball_contact === 'unknown')) fielding = 'warn'
  // A HOME RUN OVER THE FENCE HAS NO FIELDING, and that is the result rather
  // than a gap in it -- the same reason a walk is n/a. Without this every clean
  // home run failed the "produced nothing at all" test below and spent the game
  // on the strip as a fielding warning nobody could act on; four of them in
  // mario_stadium-20260904T000419Z. A home run that was TOUCHED -- robbed at
  // the wall, deflected over -- has events and is judged on them as usual.
  else if (HOME_RUN_RESULTS.has(atBat.result) && !(play.fielding_events || []).length
    && !play.landing && !play.first_touch) fielding = 'n/a'
  else if (!(play.fielding_events || []).length && !play.landing) fielding = 'warn'
  else fielding = 'ok'

  const runnersBefore = atBat.runners_before || {}
  const anyRunners = Boolean(runnersBefore.first || runnersBefore.second || runnersBefore.third)
  const running = !atBat.result ? 'pending'
    : severity(['runner-', 'runs-', 'outs-', 'base-', 'out-result-']) ? 'warn'
      : !atBat.runner_assignments ? (anyRunners ? 'warn' : 'warn')
        : 'ok'

  return { pitching, batting, fielding, running }
}
