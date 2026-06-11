import {
  computeLeagueConstants,
  inningsAsDecimal,
  summarizeAdvancedBatting,
  summarizeAdvancedPitching,
  summarizeBatting,
  summarizePitching,
} from './statsCalculator'
import { analyzeCharacterTalent } from './characterAnalysis'

const POSITION_LABELS = {
  1: 'P',
  2: 'C',
  3: '1B',
  4: '2B',
  5: '3B',
  6: 'SS',
  7: 'LF',
  8: 'CF',
  9: 'RF',
}

export const OVERALL_WEIGHTS = { batting: 0.35, pitching: 0.35, fielding: 0.2, speed: 0.1 }

const SEASON_WEIGHT = 0.7
const HISTORY_WEIGHT = 0.3

const BATTING_SWING = 0.3
const BATTING_CAP = 15
const PITCHING_SWING = 0.3
const PITCHING_CAP = 15
const FIELDING_SWING = 0.6
const FIELDING_CAP = 10

const BATTING_PA_THRESHOLD = 30
const PITCHING_IP_THRESHOLD = 8
const FIELDING_CHANCES_THRESHOLD = 30

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function average(values = []) {
  const valid = values.filter((value) => Number.isFinite(value))
  if (!valid.length) return 0
  return valid.reduce((sum, value) => sum + value, 0) / valid.length
}

function roundNumber(value, digits = 1) {
  if (!Number.isFinite(value)) return 0
  return Number(value.toFixed(digits))
}

function formatSignedNumber(value, digits = 1) {
  const numeric = roundNumber(value, digits)
  if (numeric > 0) return `+${numeric.toFixed(digits)}`
  if (numeric < 0) return numeric.toFixed(digits)
  return `0.${'0'.repeat(digits)}`
}

function sampleWeight(count, threshold) {
  return clamp(Number(count || 0) / threshold, 0, 1)
}

function buildEmptyFieldingSummary() {
  return {
    games: 0,
    chances: 0,
    errors: 0,
    cleanPlays: 0,
    errorRate: 0,
    positionsPlayed: 0,
    primaryPosition: '-',
  }
}

function buildFieldingSummaryByGroup({
  plateAppearances = [],
  gameFielders = [],
  nameById = {},
} = {}) {
  const findFielderForPa = (pa = {}) => gameFielders.find((fielder) => (
    String(fielder.game_id) === String(pa.game_id) &&
    Number(fielder.position) === Number(pa.hit_location || pa.error_position) &&
    Number(fielder.inning_from || 1) <= Number(pa.inning || 1) &&
    (fielder.inning_to == null || Number(fielder.inning_to) >= Number(pa.inning || 1)) &&
    String(fielder.team_id) === String(pa.defensive_team_id)
  ))

  const summaries = {}
  const matchedErrorIds = new Set()

  const ensureSummary = (groupId) => {
    const key = String(groupId)
    if (!summaries[key]) {
      summaries[key] = {
        id: key,
        name: nameById[key] || 'Unknown',
        gamesSet: new Set(),
        positionsSet: new Set(),
        positionCounts: {},
        chances: 0,
        errors: 0,
      }
    }
    return summaries[key]
  }

  plateAppearances
    .filter((pa) => pa.hit_location)
    .forEach((pa) => {
      const fielder = findFielderForPa(pa)
      if (!fielder?.team_id) return

      const summary = ensureSummary(fielder.team_id)
      const position = POSITION_LABELS[Number(fielder.position)] || String(fielder.position || '-')
      const isError = Boolean(pa.is_error) && String(pa.error_character) === String(fielder.character)

      summary.gamesSet.add(String(pa.game_id))
      summary.positionsSet.add(position)
      summary.positionCounts[position] = (summary.positionCounts[position] || 0) + 1
      summary.chances += 1
      if (isError) {
        summary.errors += 1
        matchedErrorIds.add(String(pa.id))
      }
    })

  plateAppearances
    .filter((pa) => pa.is_error && !matchedErrorIds.has(String(pa.id)) && pa.defensive_team_id)
    .forEach((pa) => {
      const summary = ensureSummary(pa.defensive_team_id)
      summary.gamesSet.add(String(pa.game_id))
      summary.errors += 1
    })

  return Object.fromEntries(
    Object.entries(summaries).map(([groupId, summary]) => {
      const primaryPosition = Object.entries(summary.positionCounts)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || '-'

      return [groupId, {
        id: summary.id,
        name: summary.name,
        games: summary.gamesSet.size,
        chances: summary.chances,
        errors: summary.errors,
        cleanPlays: Math.max(0, summary.chances - summary.errors),
        errorRate: summary.chances ? summary.errors / summary.chances : 0,
        positionsPlayed: summary.positionsSet.size,
        primaryPosition,
      }]
    }),
  )
}

function buildRosterBaseline(rosterEntries = [], characters = []) {
  const displayRatingsByName = Object.fromEntries(
    characters
      .map((character) => [character.name, analyzeCharacterTalent(character)?.displayRatings])
      .filter(([, displayRatings]) => Boolean(displayRatings)),
  )

  const ratings = rosterEntries
    .map((entry) => displayRatingsByName[entry.character_name])
    .filter(Boolean)

  if (!ratings.length) {
    return { overall: 50, batting: 50, pitching: 50, fielding: 50, speed: 50, rosterSize: 0 }
  }

  const buildCategoryBaseline = (key) => clamp(average(ratings.map((entry) => Number(entry[key] || 0))), 1, 99)

  return {
    overall: buildCategoryBaseline('overall'),
    batting: buildCategoryBaseline('batting'),
    pitching: buildCategoryBaseline('pitching'),
    fielding: buildCategoryBaseline('fielding'),
    speed: buildCategoryBaseline('speed'),
    rosterSize: ratings.length,
  }
}

function buildBattingPerformance(teamPas = [], leagueConstants = {}) {
  const summary = summarizeBatting(teamPas)
  const advanced = summarizeAdvancedBatting(teamPas, leagueConstants)
  if (!teamPas.length) return { delta: 0, weight: 0, summary, advanced }

  return {
    delta: (advanced.wrcPlus || 100) - 100,
    weight: sampleWeight(summary.plateAppearances, BATTING_PA_THRESHOLD),
    summary,
    advanced,
  }
}

function buildPitchingPerformance(teamStints = [], leagueConstants = {}) {
  const summary = summarizePitching(teamStints)
  const advanced = summarizeAdvancedPitching(teamStints, leagueConstants)
  if (!teamStints.length) return { delta: 0, weight: 0, summary, advanced }

  return {
    delta: ((100 - (advanced.fipMinus || 100)) + (100 - (advanced.eraMinus || 100))) / 2,
    weight: sampleWeight(inningsAsDecimal(summary.innings || 0), PITCHING_IP_THRESHOLD),
    summary,
    advanced,
  }
}

function buildFieldingPerformance(teamFielding = buildEmptyFieldingSummary(), leagueErrorRate = 0) {
  if (!teamFielding.chances) return { delta: 0, weight: 0, summary: teamFielding }

  return {
    delta: (leagueErrorRate - Number(teamFielding.errorRate || 0)) * 100,
    weight: sampleWeight(teamFielding.chances, FIELDING_CHANCES_THRESHOLD),
    summary: teamFielding,
  }
}

function combinePerformance(current, historical, swing, cap) {
  const seasonContribution = (current?.delta || 0) * (current?.weight || 0) * SEASON_WEIGHT
  const historyContribution = (historical?.delta || 0) * (historical?.weight || 0) * HISTORY_WEIGHT
  return clamp((seasonContribution + historyContribution) * swing, -cap, cap)
}

function buildPerformanceBreakdown({
  key,
  label,
  color,
  baseline,
  adjustment,
  finalRating,
  formula,
  summaryLines,
  scaleReference,
}) {
  return {
    key,
    label,
    color,
    finalRating: roundNumber(finalRating, 1),
    rawRating: roundNumber(finalRating, 1),
    formula,
    summaryLines,
    scaleReference,
    components: [
      { label: 'Roster baseline', value: roundNumber(baseline, 1), display: roundNumber(baseline, 1).toFixed(1) },
      { label: 'Performance adjustment', value: roundNumber(adjustment, 1), display: formatSignedNumber(adjustment, 1) },
      { label: 'Final displayed rating', value: roundNumber(finalRating, 1), display: roundNumber(finalRating, 1).toFixed(1) },
    ],
  }
}

function buildBaselineOnlyBreakdown({ key, label, color, baseline, finalRating, formula, summaryLines, scaleReference }) {
  return {
    key,
    label,
    color,
    finalRating: roundNumber(finalRating, 1),
    rawRating: roundNumber(finalRating, 1),
    formula,
    summaryLines,
    scaleReference,
    components: [
      { label: 'Roster baseline', value: roundNumber(baseline, 1), display: roundNumber(baseline, 1).toFixed(1) },
      { label: 'Final displayed rating', value: roundNumber(finalRating, 1), display: roundNumber(finalRating, 1).toFixed(1) },
    ],
  }
}

export function buildSeasonPowerRankings({
  seasonTeams = [],
  standings = [],
  roster = [],
  characters = [],
  plateAppearances = [],
  pitchingStints = [],
  gameFielders = [],
  historicalPlateAppearances = [],
  historicalPitchingStints = [],
  historicalGameFielders = [],
} = {}) {
  const activeRoster = roster.filter((entry) => entry.is_active !== false)
  const rosterByTeamId = activeRoster.reduce((accumulator, entry) => {
    const key = String(entry.team_id)
    accumulator[key] = accumulator[key] || []
    accumulator[key].push(entry)
    return accumulator
  }, {})

  const teamIdByPlayerId = Object.fromEntries(seasonTeams.map((team) => [String(team.player_id), team.id]))
  const seasonTeamNameById = Object.fromEntries(seasonTeams.map((team) => [String(team.id), team.team_name || 'Season Team']))
  const historicalNameByPlayerId = Object.fromEntries(seasonTeams.map((team) => [String(team.player_id), team.team_name || 'Season Team']))

  const plateAppearancesByTeamId = plateAppearances.reduce((accumulator, pa) => {
    const resolvedTeamId = pa.batting_team_id || teamIdByPlayerId[String(pa.player_id)]
    if (!resolvedTeamId) return accumulator
    const key = String(resolvedTeamId)
    accumulator[key] = accumulator[key] || []
    accumulator[key].push(pa)
    return accumulator
  }, {})
  const pitchingByTeamId = pitchingStints.reduce((accumulator, stint) => {
    const resolvedTeamId = teamIdByPlayerId[String(stint.player_id)]
    if (!resolvedTeamId) return accumulator
    const key = String(resolvedTeamId)
    accumulator[key] = accumulator[key] || []
    accumulator[key].push(stint)
    return accumulator
  }, {})
  const historicalPasByPlayerId = historicalPlateAppearances.reduce((accumulator, pa) => {
    if (!pa.player_id) return accumulator
    const key = String(pa.player_id)
    accumulator[key] = accumulator[key] || []
    accumulator[key].push(pa)
    return accumulator
  }, {})
  const historicalPitchingByPlayerId = historicalPitchingStints.reduce((accumulator, stint) => {
    if (!stint.player_id) return accumulator
    const key = String(stint.player_id)
    accumulator[key] = accumulator[key] || []
    accumulator[key].push(stint)
    return accumulator
  }, {})

  const seasonFieldingByTeamId = buildFieldingSummaryByGroup({
    plateAppearances,
    gameFielders,
    nameById: seasonTeamNameById,
  })
  const historicalFieldingByPlayerId = buildFieldingSummaryByGroup({
    plateAppearances: historicalPlateAppearances,
    gameFielders: historicalGameFielders,
    nameById: historicalNameByPlayerId,
  })

  const standingsByTeamId = Object.fromEntries(standings.map((team) => [String(team.id), team]))
  const currentLeagueConstants = computeLeagueConstants(plateAppearances, pitchingStints)
  const historicalLeagueConstants = computeLeagueConstants(historicalPlateAppearances, historicalPitchingStints)
  const currentLeagueErrorRate = average(Object.values(seasonFieldingByTeamId).map((entry) => entry.errorRate))
  const historicalLeagueErrorRate = average(Object.values(historicalFieldingByPlayerId).map((entry) => entry.errorRate))

  return seasonTeams.map((team) => {
    const playerKey = String(team.player_id)
    const teamRoster = rosterByTeamId[String(team.id)] || []
    const baseline = buildRosterBaseline(teamRoster, characters)

    const teamPas = plateAppearancesByTeamId[String(team.id)] || []
    const teamStints = pitchingByTeamId[String(team.id)] || []
    const teamFielding = seasonFieldingByTeamId[String(team.id)] || buildEmptyFieldingSummary()
    const historicalPas = historicalPasByPlayerId[playerKey] || []
    const historicalStints = historicalPitchingByPlayerId[playerKey] || []
    const historicalFielding = historicalFieldingByPlayerId[playerKey] || buildEmptyFieldingSummary()

    const currentBatting = buildBattingPerformance(teamPas, currentLeagueConstants)
    const historicalBatting = buildBattingPerformance(historicalPas, historicalLeagueConstants)
    const battingAdjustment = combinePerformance(currentBatting, historicalBatting, BATTING_SWING, BATTING_CAP)
    const battingRating = clamp(baseline.batting + battingAdjustment, 1, 99)

    const currentPitching = buildPitchingPerformance(teamStints, currentLeagueConstants)
    const historicalPitching = buildPitchingPerformance(historicalStints, historicalLeagueConstants)
    const pitchingAdjustment = combinePerformance(currentPitching, historicalPitching, PITCHING_SWING, PITCHING_CAP)
    const pitchingRating = clamp(baseline.pitching + pitchingAdjustment, 1, 99)

    const currentFielding = buildFieldingPerformance(teamFielding, currentLeagueErrorRate)
    const historicalFieldingPerformance = buildFieldingPerformance(historicalFielding, historicalLeagueErrorRate)
    const fieldingAdjustment = combinePerformance(currentFielding, historicalFieldingPerformance, FIELDING_SWING, FIELDING_CAP)
    const fieldingRating = clamp(baseline.fielding + fieldingAdjustment, 1, 99)

    const speedRating = clamp(baseline.speed, 1, 99)

    const overallRating = clamp(
      (battingRating * OVERALL_WEIGHTS.batting) +
      (pitchingRating * OVERALL_WEIGHTS.pitching) +
      (fieldingRating * OVERALL_WEIGHTS.fielding) +
      (speedRating * OVERALL_WEIGHTS.speed),
      1,
      99,
    )

    const standing = standingsByTeamId[String(team.id)] || team

    const ratingBreakdowns = {
      batting: buildPerformanceBreakdown({
        key: 'battingRating',
        label: 'Batting',
        color: '#22C55E',
        baseline: baseline.batting,
        adjustment: battingAdjustment,
        finalRating: battingRating,
        formula: 'Roster baseline (avg. character batting OVR) + blended performance adjustment (70% current season, 30% history, scaled by sample size, capped at ±15).',
        summaryLines: [
          `Roster baseline ${roundNumber(baseline.batting, 1).toFixed(1)} = average batting OVR across ${baseline.rosterSize} active roster player(s)`,
          `Current season: wRC+ ${Math.round(currentBatting.advanced.wrcPlus || 100)} (${formatSignedNumber(currentBatting.delta, 0)} vs league avg 100) over ${currentBatting.summary.plateAppearances || 0} PA — confidence ${roundNumber(currentBatting.weight, 2).toFixed(2)}`,
          `History: wRC+ ${Math.round(historicalBatting.advanced.wrcPlus || 100)} (${formatSignedNumber(historicalBatting.delta, 0)}) over ${historicalBatting.summary.plateAppearances || 0} PA — confidence ${roundNumber(historicalBatting.weight, 2).toFixed(2)}`,
          `Blended performance adjustment (70% current / 30% history) = ${formatSignedNumber(battingAdjustment, 1)}`,
        ],
        scaleReference: 'Roster baseline is the average character batting OVR of the active roster.',
      }),
      pitching: buildPerformanceBreakdown({
        key: 'pitchingRating',
        label: 'Pitching',
        color: '#EF4444',
        baseline: baseline.pitching,
        adjustment: pitchingAdjustment,
        finalRating: pitchingRating,
        formula: 'Roster baseline (avg. character pitching OVR) + blended performance adjustment (70% current season, 30% history, scaled by sample size, capped at ±15).',
        summaryLines: [
          `Roster baseline ${roundNumber(baseline.pitching, 1).toFixed(1)} = average pitching OVR across ${baseline.rosterSize} active roster player(s)`,
          `Current season: FIP- ${Math.round(currentPitching.advanced.fipMinus || 100)} | ERA- ${Math.round(currentPitching.advanced.eraMinus || 100)} over ${roundNumber(currentPitching.summary.innings || 0, 1).toFixed(1)} IP — confidence ${roundNumber(currentPitching.weight, 2).toFixed(2)}`,
          `History: FIP- ${Math.round(historicalPitching.advanced.fipMinus || 100)} | ERA- ${Math.round(historicalPitching.advanced.eraMinus || 100)} over ${roundNumber(historicalPitching.summary.innings || 0, 1).toFixed(1)} IP — confidence ${roundNumber(historicalPitching.weight, 2).toFixed(2)}`,
          `Blended performance adjustment (70% current / 30% history) = ${formatSignedNumber(pitchingAdjustment, 1)}`,
        ],
        scaleReference: 'Roster baseline is the average character pitching OVR of the active roster. FIP-/ERA- are scaled to a league average of 100 — lower is better.',
      }),
      fielding: buildPerformanceBreakdown({
        key: 'fieldingRating',
        label: 'Fielding',
        color: '#EAB308',
        baseline: baseline.fielding,
        adjustment: fieldingAdjustment,
        finalRating: fieldingRating,
        formula: 'Roster baseline (avg. character fielding OVR) + blended performance adjustment (70% current season, 30% history, scaled by sample size, capped at ±10).',
        summaryLines: [
          `Roster baseline ${roundNumber(baseline.fielding, 1).toFixed(1)} = average fielding OVR across ${baseline.rosterSize} active roster player(s)`,
          `Current season: ${currentFielding.summary.cleanPlays || 0} clean plays / ${currentFielding.summary.errors || 0} errors on ${currentFielding.summary.chances || 0} tracked chances — confidence ${roundNumber(currentFielding.weight, 2).toFixed(2)}`,
          `History: ${historicalFieldingPerformance.summary.errors || 0} errors on ${historicalFieldingPerformance.summary.chances || 0} tracked chances — confidence ${roundNumber(historicalFieldingPerformance.weight, 2).toFixed(2)}`,
          `Blended performance adjustment (70% current / 30% history) = ${formatSignedNumber(fieldingAdjustment, 1)}${currentFielding.weight || historicalFieldingPerformance.weight ? '' : ' — error tracking starts next season, so this is roster skill only for now'}`,
        ],
        scaleReference: 'Roster baseline is the average character fielding OVR of the active roster. Performance adjustment activates automatically once fielding chances are tracked.',
      }),
      speed: buildBaselineOnlyBreakdown({
        key: 'speedRating',
        label: 'Speed',
        color: '#38BDF8',
        baseline: baseline.speed,
        finalRating: speedRating,
        formula: 'Roster baseline (avg. character speed OVR) only — speed is treated as pure roster skill with no performance adjustment.',
        summaryLines: [
          `Roster baseline ${roundNumber(baseline.speed, 1).toFixed(1)} = average speed OVR across ${baseline.rosterSize} active roster player(s)`,
          'Speed is purely skill-based, so no current-season or historical performance adjustment is applied.',
        ],
        scaleReference: 'Roster baseline is the average character speed OVR of the active roster.',
      }),
    }

    ratingBreakdowns.overall = {
      key: 'overallRating',
      label: 'Overall',
      color: '#F8FAFC',
      finalRating: roundNumber(overallRating, 1),
      rawRating: roundNumber(overallRating, 1),
      formula: `${OVERALL_WEIGHTS.batting.toFixed(2)} × BAT + ${OVERALL_WEIGHTS.pitching.toFixed(2)} × PIT + ${OVERALL_WEIGHTS.fielding.toFixed(2)} × FLD + ${OVERALL_WEIGHTS.speed.toFixed(2)} × SPD.`,
      summaryLines: [
        `BAT ${battingRating.toFixed(1)} × ${OVERALL_WEIGHTS.batting.toFixed(2)} = ${(battingRating * OVERALL_WEIGHTS.batting).toFixed(1)}`,
        `PIT ${pitchingRating.toFixed(1)} × ${OVERALL_WEIGHTS.pitching.toFixed(2)} = ${(pitchingRating * OVERALL_WEIGHTS.pitching).toFixed(1)}`,
        `FLD ${fieldingRating.toFixed(1)} × ${OVERALL_WEIGHTS.fielding.toFixed(2)} = ${(fieldingRating * OVERALL_WEIGHTS.fielding).toFixed(1)}`,
        `SPD ${speedRating.toFixed(1)} × ${OVERALL_WEIGHTS.speed.toFixed(2)} = ${(speedRating * OVERALL_WEIGHTS.speed).toFixed(1)}`,
      ],
      components: [
        { label: 'Batting weight', value: roundNumber(battingRating * OVERALL_WEIGHTS.batting, 1), display: `${battingRating.toFixed(1)} × ${OVERALL_WEIGHTS.batting.toFixed(2)} = ${(battingRating * OVERALL_WEIGHTS.batting).toFixed(1)}` },
        { label: 'Pitching weight', value: roundNumber(pitchingRating * OVERALL_WEIGHTS.pitching, 1), display: `${pitchingRating.toFixed(1)} × ${OVERALL_WEIGHTS.pitching.toFixed(2)} = ${(pitchingRating * OVERALL_WEIGHTS.pitching).toFixed(1)}` },
        { label: 'Fielding weight', value: roundNumber(fieldingRating * OVERALL_WEIGHTS.fielding, 1), display: `${fieldingRating.toFixed(1)} × ${OVERALL_WEIGHTS.fielding.toFixed(2)} = ${(fieldingRating * OVERALL_WEIGHTS.fielding).toFixed(1)}` },
        { label: 'Speed weight', value: roundNumber(speedRating * OVERALL_WEIGHTS.speed, 1), display: `${speedRating.toFixed(1)} × ${OVERALL_WEIGHTS.speed.toFixed(2)} = ${(speedRating * OVERALL_WEIGHTS.speed).toFixed(1)}` },
        { label: 'Final displayed rating', value: roundNumber(overallRating, 1), display: roundNumber(overallRating, 1).toFixed(1) },
      ],
    }

    return {
      id: team.id,
      playerId: team.player_id,
      teamName: team.team_name || standing.team_name || 'Season Team',
      battingRating: roundNumber(battingRating, 1),
      pitchingRating: roundNumber(pitchingRating, 1),
      fieldingRating: roundNumber(fieldingRating, 1),
      speedRating: roundNumber(speedRating, 1),
      overallRating: roundNumber(overallRating, 1),
      rosterSize: baseline.rosterSize,
      battingSummary: currentBatting.summary,
      battingAdvanced: currentBatting.advanced,
      pitchingSummary: currentPitching.summary,
      pitchingAdvanced: currentPitching.advanced,
      fieldingSummary: currentFielding.summary,
      historySummary: {
        battingGames: historicalBatting.summary.games || 0,
        pitchingGames: historicalPitching.summary.games || 0,
        fieldingGames: historicalFielding.games || 0,
      },
      adjustmentBreakdown: {
        batting: battingAdjustment,
        pitching: pitchingAdjustment,
        fielding: fieldingAdjustment,
        speed: 0,
      },
      ratingBreakdowns,
    }
  })
}
