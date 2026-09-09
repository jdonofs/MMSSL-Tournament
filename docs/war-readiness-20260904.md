# Sluggers WAR readiness — September 4, 2026

We can build an experimental Sluggers WAR from the existing batting and pitching
records. A complete, calibrated metric needs attribution, opportunity coverage
and league-specific model choices; more character movement samples alone will
not finish it.

## Data actually available

Read-only audit of the configured database, using the tracker account:

| Source | Available | Important limitation |
|---|---:|---|
| Tournament plate appearances | 266 across 10 games | No explicit outs-on-play or runner assignments |
| Season plate appearances | 302 across 12 games | Only 4 explicit outs-on-play values and 1 runner-assignment record |
| Pitching stints | 152 across tournament and season tables | Player/character IDs, innings and runs allowed are populated |
| Season fielding position spans | 441 | Tournament fielding span table has no rows |
| Tracking sessions / fielding opportunities / runner opportunities / DP opportunities / movement / throws | All six tables empty | Advanced measurements are not available to production value calculations |
| Local calibration archive | 30 sessions; 2,590 plays; 3,308 pitches | The latest capture has no game or human-player attribution; archive exposure is experimental |

All 568 PAs have batter player/character IDs and pitcher player/character IDs.
None has a tracking-session link. Explicit runner destinations are almost wholly
absent, so exact extra-base advance/hold values cannot simply be backfilled from
the result code. Some ordinary outs can be reconstructed, but reconstruction
must preserve ambiguity for force plays, extra outs and incomplete half-innings.

The aggregate query results and coverage counts are preserved in
`data/calibration/war-data-inventory.json`. Counts reflect rows visible to the
configured tracker account; no gameplay rows were written.

## Existing WAR implementation

`summarizeValueBatting` in `src/utils/statsCalculator.js` already returns a
simplified WAR. `CharacterPage.jsx` passes advanced defense/baserunning totals
when available; otherwise it uses range/error-rate fallback and zero baserunning.

Current assumptions include fixed batting weights, wOBA scale 1.15,
replacement runs of 0.06 per PA, six runs per win, and fixed positional
adjustments scaled by batting PA. The character page uses a primary position
rather than a full exposure-weighted position history. Advanced fielding converts
OAA at a fixed 0.8 runs per out. These are assumptions, not fitted constants.
The WAR function does not include pitching value.

## Path to a usable first version

1. Establish a versioned credit ledger from actual league PAs, pitching stints
   and fielding spans. Preserve both human-player and character identities.
   Keep unowned calibration exhibitions in the training dataset, not human
   career totals.
2. Fit batting event values and runs-to-wins conversion to completed league
   games and their inning format. Validate reconstructed outs/runs before fitting
   run expectancy; do not use RBI alone as total runs on a play.
3. Choose and publish a replacement convention separately for humans and
   characters. An undrafted/reserve character and a substitute human are
   different reference populations. A small human pool needs a stable declared
   baseline, not a baseline that changes dramatically with one game.
4. Add pitching value with a deliberate allocation of balls-in-play value
   between pitching and defense. Charging a pitcher for all runs while also
   charging the fielder for the same failure double-counts the loss.
5. Join validated tracking to real games, then enable fielding and extra-base
   components with coverage markers. Missing components must not masquerade as
   measured zero. Do not add both legacy Range Runs and OAA value for one play,
   or both raw sprint/arm speed and the run value of their outcomes.
6. Validate on held-out games: component totals, team run reconciliation,
   park/rules splits, calibration error and sensitivity to replacement level.
   Keep experimental values visibly versioned until those checks pass.

Human-player WAR and character WAR can be two aggregations of the same credited
events. They describe the same on-field value from different perspectives and
must not be added together. Estimating human skill independent of character
strength would require a separate model controlling for roster, opponents and
park; ordinary WAR aggregation does not provide that separation.

WAR is a derived run-value model rather than an additional memory measurement.
The standard position-player structure combines batting, baserunning, defense,
context and replacement runs before converting to wins; the runs-per-win scale
depends on the run environment. See [FanGraphs' WAR methodology](https://library.fangraphs.com/war/war-position-players/).
Pitching also requires a chosen method for defense and context adjustment; see
[Baseball-Reference's pitching WAR methodology](https://www.baseball-reference.com/about/war_explained_pitch.shtml).
