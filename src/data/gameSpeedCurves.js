// Movement-speed tables from the public Sluggers datamine workbook, and what
// the game's own memory says about them.
//
// The workbook publishes one speed per 10 points of the speed stat, in world
// units PER FRAME. A game-second is GAME_FRAME_RATE ticks, matching
// GAME_FRAME_RATE in scripts/derive_player_metrics.py; 60 is the wrong
// constant and puts every value 0.1% high.
//
// ─── What the fielding curve has been checked against ───────────────────────
//
// The fielder actor carries its own top speed at +0x0F0 (the acceleration
// constant the game sets to max_speed/15). Over the local archive -- 41
// sessions after the calibration-excluded ones are dropped, of 59 present --
// for the 72 characters that hold one:
//
//   * the axis is the characters table's `run_speed`, 0-100. King K. Rool
//     (run_speed 10) holds 0.121 u/frame and Yoshi (90) holds 0.141, which are
//     the published rows verbatim.
//   * 70 of the 72 land on this table. Median |error| 0.0002 u/s, worst
//     0.0005 -- at the capture's own resolution floor, which is HALF the
//     0.001 u/s grid it rounds to, so the agreement cannot be claimed any
//     finer than that. (derive_player_metrics.py rounds u/s and ft/s to three
//     decimals independently from the same unrounded constant, so the feet
//     value is on a 0.001 ft/s grid rather than inheriting the u/s one.)
//   * LINEAR INTERPOLATION IS CONFIRMED, not assumed. 24 of those 70 sit
//     between published rows -- run_speed 14, 25, 29, 35, 44, 52, 57, 64, 72,
//     85 -- and every one holds the interpolated value. Pink Yoshi at 85 holds
//     0.1385, the midpoint of 0.136 and 0.141, and not either endpoint.
//   * the 2 that do not match are Dry Bones and Green Paratroopa, and the
//     evidence points at the characters table rather than at the curve: Dry
//     Bones holds the run_speed-50 value against an entry of 40, and Green
//     Paratroopa holds ordinary Paratroopa's run_speed-52 value against an
//     entry of 64. Not corrected here -- see the prepared migration noted in
//     docs/tracker-validation-console.md.
//
// Reproduce with `node scripts/audit_character_mechanics.mjs`, under "SAME
// CURVE CHECK, LOCAL ARCHIVE SCOPE". That report also carries the DATABASE
// scope of the same check, which is a smaller population -- the database holds
// only the sessions that were ingested -- and the two counts are not
// interchangeable.
//
// ─── Rows above 100, and the boost ──────────────────────────────────────────
//
// No character has a run_speed above 100, so the published rows past that one
// looked like padding. They are not: they are the domain a boosted fielder
// lands in, and the boost multiplies the STAT and re-reads this same table
// rather than scaling the resulting speed.
//
// In one session -- wario_stadium-20260826T005958Z -- 16 of the 18 fielders on
// the two teams hold the curve value at floor(run_speed * 1.5). Bowser Jr. (70)
// holds 0.144, the row for stat 105; Wiggler (75) holds 0.1456, the row for
// 112. The other two are Dry Bones and Green Paratroopa, whose ordinary rating
// is already wrong in the characters table, so they miss both rows. Scaling the
// SPEED by 1.5 would have predicted 12.1 and 12.2 u/s, so the distinction
// between multiplying the stat and multiplying the speed matters.
//
// THE RULE IS OBSERVED; THE TRIGGER IS A HYPOTHESIS AND NOT EVEN THAT YET.
// What is established is the arithmetic: given a boosted row, floor(stat * 1.5)
// reproduces it. What is NOT established is what puts a fielder in that state.
// Exactly one session in the archive shows it, and that session is also the
// only Wario Stadium capture AND the oldest MSSTRK02 one, so a park effect, a
// game setting and a collector artifact are perfectly confounded -- there is no
// evidence favouring any of the three. A second Wario Stadium capture with the
// current collector would separate the park from the rest; it would not on its
// own identify a setting.
//
// Until then a constant matching the boosted row is labelled boosted and kept
// out of ordinary baselines, and a constant matching NEITHER row is left
// unclassified rather than assigned to the nearer one. See
// summarizeMovementMetrics in src/utils/advancedDefense.js.
//
// ─── The baserunning curve is NOT validated ─────────────────────────────────
//
// The offense actor class does not carry either speed field (confirmed across
// 40,000 frames in ACTOR_FIELDS, collect_player_tracking.py), so there is no
// in-memory constant to check these rows against.
//
// THE MEASURED RUNNER IS A GOOD MEASUREMENT OF SOMETHING ELSE. It tracks the
// rating closely -- r = 0.87 against run_speed over 71 characters, the
// top-two-thirds-mean estimator in scripts/verify_speed_against_attributes.mjs
// -- but it does not land on THESE VALUES: it sits at 1.14x them, and tightly,
// p10 1.12 to p90 1.17. A consistent offset is not noise, and correlating with
// the curve's INPUT axis is not evidence about its OUTPUT. Compare the fielding
// curve above, where the constant lands on the published value at the capture's
// own rounding floor; that is what agreement looks like here.
//
// (An earlier note in this file cited r = 0.36 and 1.26x. Those came from a p99
// estimator over unfiltered windows -- effectively each character's noisiest
// single run. Both controls are in `node scripts/audit_character_mechanics.mjs`,
// and both now hold the character cohort, the >=6 sample threshold and the
// input rows fixed so that exactly one thing changes at a time. Over the same
// 71 characters: swapping the ESTIMATOR takes r from 0.87 to 0.34, and
// swapping the FILTERS takes it from 0.87 to 0.88. The estimator was the whole
// effect. An earlier version of those controls also moved the threshold from 6
// to 15, so they ran over 53-54 characters instead of 71 and attributed a
// cohort change to whichever knob the label named.)
//
// So these rows are published as-is and flagged unvalidated. Nothing should
// present them as measured or confirmed, and nothing should present the
// measured runner sprint as a reading of them.

// Matches GAME_FRAME_RATE in scripts/derive_player_metrics.py. The Wii runs
// NTSC, so a second is 59.94 ticks and not 60.
export const GAME_FRAME_RATE = 59.94

// The highest speed stat any character actually has. Ratings are 0-100; the
// published rows above this are only reachable through the boost below.
export const ORDINARY_STAT_MAX = 100

// The boost multiplies the STAT, floored to an integer, and re-reads the same
// curve. It does not multiply the speed.
export const SPEED_BOOST_STAT_MULTIPLIER = 1.5

const toPerSecond = (speedPerFrame) => Number((speedPerFrame * GAME_FRAME_RATE).toFixed(6))

const freezeCurve = (rows) => Object.freeze(rows.map(([stat, speedPerFrame]) => Object.freeze({
  stat,
  speedPerFrame,
  speedPerSecond: toPerSecond(speedPerFrame),
})))

export const BASERUN_SPEED_CURVE = freezeCurve([
  [0, 0.122], [10, 0.125], [20, 0.127], [30, 0.129], [40, 0.131],
  [50, 0.133], [60, 0.135], [70, 0.138], [80, 0.141], [90, 0.144],
  [100, 0.147], [110, 0.150], [120, 0.154], [130, 0.158], [140, 0.163],
  [150, 0.166], [160, 0.169], [170, 0.172], [180, 0.175], [190, 0.178],
  [200, 0.180], [210, 0.180], [220, 0.158], [230, 0.162], [240, 0.164],
  [250, 0.167], [260, 0.169], [270, 0.172], [280, 0.174], [290, 0.178],
  [300, 0.181], [310, 0.185], [320, 0.188], [330, 0.192], [340, 0.197],
  [350, 0.202], [360, 0.208], [370, 0.211], [380, 0.215], [390, 0.218],
  [400, 0.222], [410, 0.226], [420, 0.228],
])

export const FIELD_SPEED_CURVE = freezeCurve([
  [0, 0.120], [10, 0.121], [20, 0.122], [30, 0.128], [40, 0.129],
  [50, 0.130], [60, 0.134], [70, 0.135], [80, 0.136], [90, 0.141],
  [100, 0.143], [110, 0.145], [120, 0.148], [130, 0.150], [140, 0.153],
  [150, 0.155], [160, 0.157], [170, 0.159], [180, 0.161], [190, 0.163],
  [200, 0.165], [210, 0.165], [220, 0.135], [230, 0.140], [240, 0.145],
  [250, 0.150], [260, 0.155], [270, 0.160], [280, 0.165], [290, 0.170],
  [300, 0.175], [310, 0.180], [320, 0.185], [330, 0.190], [340, 0.195],
  [350, 0.200], [360, 0.200], [370, 0.200], [380, 0.200], [390, 0.200],
  [400, 0.200], [410, 0.200], [420, 0.200],
])

// What each curve has actually been checked against, so a caller can decide
// whether to present a value as an expectation or only as a published number.
export const SPEED_CURVE_VALIDATION = Object.freeze({
  fielding: Object.freeze({
    validated: true,
    against: 'fielder actor +0x0F0 max-speed constant',
    // LOCAL ARCHIVE, not the database: the numbers below come from
    // data/player_tracking, which holds sessions that were never ingested. The
    // database scope of the same check is smaller and is reported separately.
    scope: 'local archive (data/player_tracking)',
    sessions: 41,
    sessionFilesPresent: 59,
    calibrationExcludedSessions: 18,
    charactersWithAConstant: 72,
    charactersReproducingTheCurve: 70,
    interpolatedCharacters: 24,
    // The capture rounds to three decimals, so half a step is the floor, not a
    // precision claim: observed median |error| 0.0002, worst 0.0005.
    storedResolutionUnitsPerSecond: 0.001,
    roundingFloorUnitsPerSecond: 0.0005,
    exceptions: Object.freeze(['Dry Bones', 'Green Paratroopa']),
    reproduceWith: 'node scripts/audit_character_mechanics.mjs',
  }),
  baserunning: Object.freeze({
    validated: false,
    reason: 'the offense actor class holds no speed constant to check these '
      + 'rows against. Measured runner sprint tracks the run_speed rating '
      + '(r = 0.87, 71 characters) but sits a consistent 1.14x above these '
      + 'values (p10 1.12, p90 1.17), so it measures a different quantity.',
    reproduceWith: 'node scripts/audit_character_mechanics.mjs',
  }),
})

function sampleSpeedCurve(curve, speedStat) {
  const requestedStat = Number(speedStat)
  if (!Number.isFinite(requestedStat)) return null

  const minStat = curve[0].stat
  const maxStat = curve[curve.length - 1].stat
  const stat = Math.min(maxStat, Math.max(minStat, requestedStat))
  const lowerIndex = Math.min(Math.floor(stat / 10), curve.length - 1)
  const lower = curve[lowerIndex]
  const upper = curve[Math.min(lowerIndex + 1, curve.length - 1)]
  const fraction = upper.stat === lower.stat ? 0 : (stat - lower.stat) / (upper.stat - lower.stat)
  const speedPerFrame = lower.speedPerFrame + ((upper.speedPerFrame - lower.speedPerFrame) * fraction)

  return Object.freeze({
    requestedStat,
    stat,
    speedPerFrame,
    speedPerSecond: toPerSecond(speedPerFrame),
    exactTableEntry: fraction === 0,
    lowerStat: lower.stat,
    upperStat: upper.stat,
    // A rating above 100 is either a boosted lookup or a caller mistake;
    // either way the answer is not this character's ordinary top speed.
    beyondOrdinaryRatings: stat > ORDINARY_STAT_MAX,
  })
}

export function getBaserunSpeed(speedStat) {
  return sampleSpeedCurve(BASERUN_SPEED_CURVE, speedStat)
}

/**
 * @param {number} speedStat the characters table's run_speed, 0-100.
 * @param {{ boosted?: boolean }} [options] read the boosted row instead --
 *   floor(stat * 1.5), which is how the game applies it.
 */
export function getFieldSpeed(speedStat, { boosted = false } = {}) {
  const stat = Number(speedStat)
  if (!Number.isFinite(stat)) return null
  return sampleSpeedCurve(
    FIELD_SPEED_CURVE,
    boosted ? Math.floor(stat * SPEED_BOOST_STAT_MULTIPLIER) : stat,
  )
}

/**
 * Whether a captured max-speed constant is above what this character's rating
 * allows, i.e. the actor was boosted on that play. The tolerance is twice the
 * 0.001 u/s the capture rounds to.
 */
export function isBoostedFieldSpeed(speedStat, measuredUnitsPerSecond) {
  const ordinary = getFieldSpeed(speedStat)
  const measured = Number(measuredUnitsPerSecond)
  if (!ordinary || !Number.isFinite(measured)) return false
  return measured > ordinary.speedPerSecond + 0.002
}

export function getMovementMechanics(speedStat) {
  const stat = Number(speedStat)
  if (!Number.isFinite(stat)) return null

  return Object.freeze({
    speedStat: stat,
    // Two tables for two different activities. They are not interchangeable
    // and must never be averaged together.
    baserunning: getBaserunSpeed(stat),
    fielding: getFieldSpeed(stat),
    fieldingBoosted: getFieldSpeed(stat, { boosted: true }),
    validation: SPEED_CURVE_VALIDATION,
  })
}
