import {
  summarizeAdvancedBatting,
  summarizeAdvancedPitching,
  summarizeBatting,
  summarizePitching,
  summarizeStarHits,
  summarizeStarPitching,
} from './statsCalculator'

// Builds one team-level stat row from a team's pooled plate appearances/pitching stints —
// the same aggregation Stats.jsx's `players` tab already does per team-owner row, extracted so
// the Team page can build the identical shape for a single team without duplicating the formulas.
export function buildTeamStatRow({
  battingPas = [],
  pitchingStints = [],
  pitchingPas = [],
  pitcherPitches = [],
  leagueConstants = {},
  runEvents = [],
}) {
  const batting = summarizeBatting(battingPas, runEvents)
  batting.ops = batting.obp + batting.slg
  const pitching = summarizePitching(pitchingStints)
  const advancedBatting = summarizeAdvancedBatting(battingPas, leagueConstants)
  const advancedPitching = summarizeAdvancedPitching(pitchingStints, leagueConstants, { plateAppearances: pitchingPas })
  const starHit = summarizeStarHits(battingPas)
  const starPitch = summarizeStarPitching(pitchingPas, pitcherPitches)

  return { batting, pitching, advancedBatting, advancedPitching, starHit, starPitch }
}
