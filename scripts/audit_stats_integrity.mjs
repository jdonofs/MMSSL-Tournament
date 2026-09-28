import fs from 'node:fs'
import path from 'node:path'
import { isCreditedHit } from '../src/utils/creditedHit.js'
import { reconcileStatSource } from '../src/utils/statReconciliation.js'
import { fielderCoversPa } from '../src/utils/fielderStints.js'

const VALID_RESULTS = new Set(['1B', '2B', '3B', 'HR', 'IPHR', 'BB', 'HBP', 'K', 'GO', 'FO', 'LO', 'DP', 'TP', 'SF', 'SH', 'FC', 'ROE'])
const ZERO_RBI_RESULTS = new Set(['FC', 'ROE', 'DP', 'TP'])
const STRIKEOUT_TYPES = new Set(['KL', 'KS'])

function loadEnvFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8')
  const env = {}
  text.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex <= 0) return
    const key = trimmed.slice(0, eqIndex).trim()
    const value = trimmed.slice(eqIndex + 1).trim()
    env[key] = value
  })
  return env
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = { input: null, output: path.resolve('tmp', 'stats_audit_report.json') }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--input') options.input = path.resolve(argv[++index])
    else if (argv[index] === '--output') options.output = path.resolve(argv[++index])
    else throw new Error(`Unknown argument: ${argv[index]}`)
  }
  return options
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function outsFromInningsPitched(inningsPitched = 0) {
  const innings = Number(inningsPitched || 0)
  const whole = Math.trunc(innings)
  const fraction = Number((innings - whole).toFixed(3))

  if (Math.abs(fraction - 0.1) < 0.001) return whole * 3 + 1
  if (Math.abs(fraction - 0.2) < 0.001) return whole * 3 + 2

  const legacyOuts = Math.round(fraction * 3)
  return whole * 3 + legacyOuts
}

function inningsPitchedFromOuts(outs = 0) {
  const safeOuts = Math.max(0, Number(outs || 0))
  const wholeInnings = Math.floor(safeOuts / 3)
  const remainingOuts = safeOuts % 3
  return Number(`${wholeInnings}.${remainingOuts}`)
}

function calculateOutsForPa(result, outsOnPlay = null) {
  if (outsOnPlay != null) return Number(outsOnPlay)
  if (result === 'TP') return 3
  if (result === 'DP') return 2
  if (result === 'FC') return 1
  if (['K', 'GO', 'FO', 'LO', 'SF', 'SH'].includes(result)) return 1
  return 0
}

function normalizeRbiForPaResult(result, rbi = 0, isError = false) {
  if (isError || ZERO_RBI_RESULTS.has(result)) return 0
  return Number(rbi || 0)
}

function isHomeRunResult(result) {
  return result === 'HR' || result === 'IPHR'
}

function getPaScoringRuns(pa = {}) {
  return Number(pa.rbi || 0) + (pa.run_scored && !isHomeRunResult(pa.result) ? 1 : 0)
}

function deriveOffense(game, outsRecorded) {
  const halfInning = Math.floor(outsRecorded / 3)
  const isTop = halfInning % 2 === 0
  const inning = Math.floor(halfInning / 2) + 1
  const awayPlayerId = game.home_away_swapped ? game.team_b_player_id : game.team_a_player_id
  const homePlayerId = game.home_away_swapped ? game.team_a_player_id : game.team_b_player_id
  return {
    battingPlayerId: isTop ? awayPlayerId : homePlayerId,
    pitchingPlayerId: isTop ? homePlayerId : awayPlayerId,
    inning,
    isTop,
  }
}

function parseFieldingSequence(pa = {}) {
  const notation = String(pa.error_notation || pa.hit_notation || '')
  const baseNotation = notation.split('-E')[0]
  const positions = (baseNotation.match(/\d+/g) || [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
  const errorMatch = notation.match(/E(\d+)/)
  const parsedErrorPosition = errorMatch ? Number(errorMatch[1]) : Number(pa.error_position || 0)
  return {
    notation,
    positions,
    errorPosition: Number.isFinite(parsedErrorPosition) && parsedErrorPosition > 0 ? parsedErrorPosition : null,
  }
}

function groupBy(rows, key) {
  return rows.reduce((acc, row) => {
    const groupKey = String(row?.[key] ?? '')
    if (!acc[groupKey]) acc[groupKey] = []
    acc[groupKey].push(row)
    return acc
  }, {})
}

function sortByPaChronology(rows = []) {
  return [...rows].sort((a, b) => {
    const paA = Number(a.pa_number)
    const paB = Number(b.pa_number)
    const hasPaA = Number.isFinite(paA) && paA > 0
    const hasPaB = Number.isFinite(paB) && paB > 0
    if (hasPaA && hasPaB && paA !== paB) return paA - paB
    if (hasPaA !== hasPaB) return hasPaA ? -1 : 1

    const createdA = a.created_at ? new Date(a.created_at).getTime() : 0
    const createdB = b.created_at ? new Date(b.created_at).getTime() : 0
    if (createdA !== createdB) return createdA - createdB

    return toNumber(a.id) - toNumber(b.id)
  })
}

function pushSample(collection, value, limit = 20) {
  if (collection.length < limit) collection.push(value)
}

async function fetchAllRows(table, credentials, { select = '*', order = null } = {}) {
  const { url, anonKey, bearerToken } = credentials
  const pageSize = 1000
  const allRows = []
  let start = 0

  while (true) {
    const params = new URLSearchParams({ select })
    if (order) params.set('order', order)

    const response = await fetch(`${url}/rest/v1/${table}?${params.toString()}`, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${bearerToken}`,
        Accept: 'application/json',
        'Range-Unit': 'items',
        Range: `${start}-${start + pageSize - 1}`,
      },
    })

    if (!response.ok) {
      const body = await response.text()
      throw new Error(`Failed to fetch ${table}: ${response.status} ${response.statusText} ${body}`)
    }

    const rows = await response.json()
    allRows.push(...rows)
    if (rows.length < pageSize) break
    start += rows.length
  }

  return allRows
}

function normalizeSeasonGames(seasonGames = [], seasonTeams = []) {
  const playerIdByTeamId = Object.fromEntries(seasonTeams.map((team) => [String(team.id), team.player_id]))
  return seasonGames.map((game) => ({
    ...game,
    team_a_player_id: playerIdByTeamId[String(game.away_team_id)] ?? null,
    team_b_player_id: playerIdByTeamId[String(game.home_team_id)] ?? null,
  }))
}

function auditPlateAppearances({ scope, pas, runs }) {
  const issues = {
    invalidResult: { count: 0, samples: [] },
    invalidOfficialAb: { count: 0, samples: [] },
    normalizedRbiMismatch: { count: 0, samples: [] },
    runEventRbiMismatch: { count: 0, samples: [] },
    batterRunFlagMismatch: { count: 0, samples: [] },
    hrRunFlagMissing: { count: 0, samples: [] },
    missingPitcherId: { count: 0, samples: [] },
    missingPitcherPlayerId: { count: 0, samples: [] },
    missingDefensiveTeamId: { count: 0, samples: [] },
    invalidStrikeoutType: { count: 0, samples: [] },
    paNumberSequenceMismatch: { count: 0, samples: [] },
  }

  const runsByPaId = groupBy(runs, 'pa_id')
  const gameIdsWithRunRows = new Set(runs.map((row) => String(row.game_id)))
  const pasByGameId = groupBy(pas, 'game_id')

  for (const pa of pas) {
    const normalizedRbi = normalizeRbiForPaResult(pa.result, pa.rbi, pa.is_error)
    const shouldBeOfficialAb = !['BB', 'HBP', 'SF', 'SH'].includes(pa.result)
    const runRows = runsByPaId[String(pa.id)] || []
    const gameHasRunRows = gameIdsWithRunRows.has(String(pa.game_id))
    const batterScoredByRunRows = runRows.some((run) => {
      const hasPlayerIds = pa.player_id != null && run.scoring_player_id != null
      const hasCharacterIds = pa.character_id != null && run.scoring_character_id != null
      const playerMatches = hasPlayerIds && String(run.scoring_player_id) === String(pa.player_id)
      const characterMatches = hasCharacterIds && String(run.scoring_character_id) === String(pa.character_id)
      if (hasPlayerIds && hasCharacterIds) return playerMatches && characterMatches
      return playerMatches || characterMatches
    })

    if (!VALID_RESULTS.has(pa.result)) {
      issues.invalidResult.count += 1
      pushSample(issues.invalidResult.samples, { id: pa.id, game_id: pa.game_id, result: pa.result })
    }

    if (typeof pa.is_official_ab === 'boolean' && pa.is_official_ab !== shouldBeOfficialAb) {
      issues.invalidOfficialAb.count += 1
      pushSample(issues.invalidOfficialAb.samples, {
        id: pa.id,
        game_id: pa.game_id,
        result: pa.result,
        is_official_ab: pa.is_official_ab,
        expected: shouldBeOfficialAb,
      })
    }

    if (toNumber(pa.rbi) !== normalizedRbi) {
      issues.normalizedRbiMismatch.count += 1
      pushSample(issues.normalizedRbiMismatch.samples, {
        id: pa.id,
        game_id: pa.game_id,
        result: pa.result,
        is_error: pa.is_error,
        stored_rbi: toNumber(pa.rbi),
        expected_rbi: normalizedRbi,
      })
    }

    if (gameHasRunRows && !pa.is_error && !ZERO_RBI_RESULTS.has(pa.result)) {
      const expectedRbi = runRows.length
      if (normalizedRbi !== expectedRbi) {
        issues.runEventRbiMismatch.count += 1
        pushSample(issues.runEventRbiMismatch.samples, {
          id: pa.id,
          game_id: pa.game_id,
          result: pa.result,
          stored_rbi: normalizedRbi,
          run_rows: expectedRbi,
        })
      }
    }

    if (gameHasRunRows && Boolean(pa.run_scored) !== batterScoredByRunRows) {
      issues.batterRunFlagMismatch.count += 1
      pushSample(issues.batterRunFlagMismatch.samples, {
        id: pa.id,
        game_id: pa.game_id,
        result: pa.result,
        run_scored: Boolean(pa.run_scored),
        expected: batterScoredByRunRows,
      })
    }

    if (isHomeRunResult(pa.result) && !Boolean(pa.run_scored)) {
      issues.hrRunFlagMissing.count += 1
      pushSample(issues.hrRunFlagMissing.samples, {
        id: pa.id,
        game_id: pa.game_id,
        result: pa.result,
      })
    }

    if (pa.pitcher_id == null || pa.pitcher_id === '') {
      issues.missingPitcherId.count += 1
      pushSample(issues.missingPitcherId.samples, { id: pa.id, game_id: pa.game_id, result: pa.result })
    }

    if (pa.pitcher_player_id == null || pa.pitcher_player_id === '') {
      issues.missingPitcherPlayerId.count += 1
      pushSample(issues.missingPitcherPlayerId.samples, { id: pa.id, game_id: pa.game_id, result: pa.result })
    }

    const isFieldingRelevant = Boolean(pa.is_error) || pa.result === 'K' || Boolean(pa.hit_notation) || pa.hit_location != null || pa.error_position != null || Boolean(pa.is_buddy_jump)
    if (isFieldingRelevant && (pa.defensive_team_id == null || pa.defensive_team_id === '')) {
      issues.missingDefensiveTeamId.count += 1
      pushSample(issues.missingDefensiveTeamId.samples, { id: pa.id, game_id: pa.game_id, result: pa.result })
    }

    if (pa.result === 'K' && pa.strikeout_type != null && !STRIKEOUT_TYPES.has(pa.strikeout_type)) {
      issues.invalidStrikeoutType.count += 1
      pushSample(issues.invalidStrikeoutType.samples, {
        id: pa.id,
        game_id: pa.game_id,
        strikeout_type: pa.strikeout_type,
      })
    }

    if (pa.result !== 'K' && pa.strikeout_type != null) {
      issues.invalidStrikeoutType.count += 1
      pushSample(issues.invalidStrikeoutType.samples, {
        id: pa.id,
        game_id: pa.game_id,
        result: pa.result,
        strikeout_type: pa.strikeout_type,
      })
    }
  }

  for (const [gameId, gamePas] of Object.entries(pasByGameId)) {
    const sorted = [...gamePas].sort((a, b) => (
      toNumber(a.pa_number) - toNumber(b.pa_number)
      || toNumber(a.id) - toNumber(b.id)
    ))
    sorted.forEach((pa, index) => {
      const expected = index + 1
      if (toNumber(pa.pa_number, expected) !== expected) {
        issues.paNumberSequenceMismatch.count += 1
        pushSample(issues.paNumberSequenceMismatch.samples, {
          game_id: gameId,
          pa_id: pa.id,
          stored_pa_number: pa.pa_number,
          expected_pa_number: expected,
        })
      }
    })
  }

  return { scope, totalPas: pas.length, issues }
}

function recomputePitchingByGame({ games, pas, stints, runs }) {
  const pasByGameId = groupBy(pas, 'game_id')
  const stintsByGameId = groupBy(stints, 'game_id')
  const runsByGameId = groupBy(runs, 'game_id')
  const recomputedByStintId = {}

  for (const game of games) {
    const gameId = String(game.id)
    const gamePas = sortByPaChronology(pasByGameId[gameId] || [])
    const gameStints = [...(stintsByGameId[gameId] || [])].sort((a, b) => {
      const aTime = new Date(a.created_at || 0).getTime()
      const bTime = new Date(b.created_at || 0).getTime()
      return aTime - bTime || toNumber(a.id) - toNumber(b.id)
    })
    const gameRuns = runsByGameId[gameId] || []
    const nextStatsByStintId = Object.fromEntries(
      gameStints.map((stint) => [String(stint.id), {
        innings_pitched: 0,
        hits_allowed: 0,
        runs_allowed: 0,
        earned_runs: 0,
        walks: 0,
        strikeouts: 0,
        hr_allowed: 0,
        _outs: 0,
        _earnedKnown: true,
      }]),
    )

    let outsBeforePa = 0

    for (const pa of gamePas) {
      const defense = deriveOffense(game, outsBeforePa)
      const pitchingPlayerId = pa.pitcher_player_id || defense.pitchingPlayerId
      const paTime = new Date(pa.created_at || 0).getTime()
      // A pitcher who re-enters after being pulled gets a second stints row with the same
      // character_id/player_id — plain .find() always grabs the earliest one, dumping every PA
      // from the second outing back onto the first and leaving the re-entry stint's stats stuck
      // at 0. Disambiguate by which of the same-pitcher stints was actually open when this PA
      // happened (mirrors Scorebook.jsx's recomputePitchingStatsForGame); only fall back to the
      // earliest match when none qualify (bulk-imported games where every stint's created_at can
      // land after every PA's).
      let activeStint = null
      if (pa.pitcher_id != null) {
        const candidateStints = gameStints.filter((stint) => (
          String(stint.character_id) === String(pa.pitcher_id)
          && String(stint.player_id) === String(pitchingPlayerId)
        ))
        const eligibleCandidates = candidateStints.filter((stint) => (
          new Date(stint.created_at || 0).getTime() <= paTime
        ))
        activeStint = eligibleCandidates[eligibleCandidates.length - 1] || candidateStints[0] || null
      }

      if (!activeStint) {
        const eligibleStints = gameStints.filter((stint) => (
          String(stint.player_id) === String(pitchingPlayerId)
          && new Date(stint.created_at || 0).getTime() <= paTime
        ))
        activeStint = eligibleStints[eligibleStints.length - 1] || null
      }

      if (activeStint) {
        const targetStats = nextStatsByStintId[String(activeStint.id)]
        const outs = calculateOutsForPa(pa.result, pa.outs_on_play)
        const paRuns = gameRuns.filter((run) => String(run.pa_id) === String(pa.id))

        targetStats._outs += outs
        if (isCreditedHit(pa)) targetStats.hits_allowed += 1
        if (isCreditedHit(pa) && isHomeRunResult(pa.result)) targetStats.hr_allowed += 1
        if (pa.result === 'BB') targetStats.walks += 1
        if (pa.result === 'K') targetStats.strikeouts += 1

        if (paRuns.length > 0) {
          const paTime = new Date(pa.created_at || 0).getTime()
          for (const run of paRuns) {
            let chargedTarget = targetStats
            if (Number(run.charged_to_pitcher_id) !== Number(activeStint.character_id)) {
              const chargedStints = gameStints.filter((stint) => (
                Number(stint.character_id) === Number(run.charged_to_pitcher_id)
                && new Date(stint.created_at || 0).getTime() <= paTime
              ))
              const chargedStint = chargedStints[chargedStints.length - 1]
              if (chargedStint) chargedTarget = nextStatsByStintId[String(chargedStint.id)]
            }
            chargedTarget.runs_allowed += 1
            if (run.is_earned_run === true) chargedTarget.earned_runs += 1
            else if (run.is_earned_run !== false) chargedTarget._earnedKnown = false
          }
        } else {
          const fallbackRuns = getPaScoringRuns(pa)
          if (fallbackRuns > 0) {
            targetStats.runs_allowed += fallbackRuns
            if (pa.is_earned_run === true) targetStats.earned_runs += fallbackRuns
            else if (pa.is_earned_run !== false) targetStats._earnedKnown = false
          }
        }
      }

      outsBeforePa += calculateOutsForPa(pa.result, pa.outs_on_play)
    }

    for (const [stintId, stats] of Object.entries(nextStatsByStintId)) {
      stats.innings_pitched = inningsPitchedFromOuts(stats._outs)
      if (!stats._earnedKnown) stats.earned_runs = null
      delete stats._outs
      delete stats._earnedKnown
      recomputedByStintId[stintId] = stats
    }
  }

  return recomputedByStintId
}

function auditPitching({ scope, games, pas, stints, runs, pitches }) {
  const issues = {
    innings_pitched: { count: 0, samples: [] },
    hits_allowed: { count: 0, samples: [] },
    runs_allowed: { count: 0, samples: [] },
    earned_runs: { count: 0, samples: [] },
    walks: { count: 0, samples: [] },
    strikeouts: { count: 0, samples: [] },
    hr_allowed: { count: 0, samples: [] },
    win_loss_shape: { count: 0, samples: [] },
    save_shape: { count: 0, samples: [] },
  }

  const expectedByStintId = recomputePitchingByGame({ games, pas, stints, runs })
  const stintsByGameId = groupBy(stints, 'game_id')
  const gamesWithPitchLogs = new Set((pitches || []).map((pitch) => String(pitch.game_id)))
  const unverifiableGameIds = [...new Set(
    stints
      .filter((stint) => !gamesWithPitchLogs.has(String(stint.game_id)))
      .map((stint) => String(stint.game_id)),
  )]

  const compareStat = (field, sample) => {
    issues[field].count += 1
    pushSample(issues[field].samples, sample)
  }

  for (const stint of stints) {
    // Aggregate-imported legacy games can have synthetic PA rows but no actual
    // pitch chronology. Their workbook pitching lines are authoritative; a PA
    // reconstruction would invent discrepancies and must not be repair input.
    if (!gamesWithPitchLogs.has(String(stint.game_id))) continue
    const expected = expectedByStintId[String(stint.id)] || {
      innings_pitched: 0,
      hits_allowed: 0,
      runs_allowed: 0,
      earned_runs: 0,
      walks: 0,
      strikeouts: 0,
      hr_allowed: 0,
    }

    if (outsFromInningsPitched(stint.innings_pitched) !== outsFromInningsPitched(expected.innings_pitched)) {
      compareStat('innings_pitched', {
        id: stint.id,
        game_id: stint.game_id,
        player_id: stint.player_id,
        character_id: stint.character_id,
        stored: stint.innings_pitched,
        expected: expected.innings_pitched,
      })
    }

    for (const field of ['hits_allowed', 'runs_allowed', 'earned_runs', 'walks', 'strikeouts', 'hr_allowed']) {
      const storedValue = stint[field] == null ? null : toNumber(stint[field])
      const expectedValue = expected[field] == null ? null : toNumber(expected[field])
      if (storedValue !== expectedValue) {
        compareStat(field, {
          id: stint.id,
          game_id: stint.game_id,
          player_id: stint.player_id,
          character_id: stint.character_id,
          stored: storedValue,
          expected: expectedValue,
        })
      }
    }
  }

  for (const [gameId, gameStints] of Object.entries(stintsByGameId)) {
    const winCount = gameStints.filter((stint) => Boolean(stint.win)).length
    const lossCount = gameStints.filter((stint) => Boolean(stint.loss)).length
    const saveCount = gameStints.filter((stint) => Boolean(stint.save)).length

    if (winCount > 1 || lossCount > 1) {
      issues.win_loss_shape.count += 1
      pushSample(issues.win_loss_shape.samples, {
        game_id: gameId,
        wins: winCount,
        losses: lossCount,
        stint_ids: gameStints.filter((stint) => stint.win || stint.loss).map((stint) => stint.id),
      })
    }

    if (saveCount > 1) {
      issues.save_shape.count += 1
      pushSample(issues.save_shape.samples, {
        game_id: gameId,
        saves: saveCount,
        stint_ids: gameStints.filter((stint) => stint.save).map((stint) => stint.id),
      })
    }
  }

  return {
    scope,
    totalStints: stints.length,
    verifiedStints: stints.filter((stint) => gamesWithPitchLogs.has(String(stint.game_id))).length,
    observations: {
      unverifiableGamesWithoutPitchLogs: {
        count: unverifiableGameIds.length,
        samples: unverifiableGameIds.slice(0, 20),
      },
    },
    issues,
  }
}

function auditFielding({ scope, pas, fielders }) {
  const issues = {
    missingErrorPosition: { count: 0, samples: [] },
    missingErrorCharacter: { count: 0, samples: [] },
    missingFielderForCredit: { count: 0, samples: [] },
    missingBuddyJumpFielder: { count: 0, samples: [] },
  }
  const observations = {
    gamesWithoutFielderSnapshots: { count: 0, samples: [] },
    safeContactRowsWithLocationOnly: { count: 0, samples: [] },
  }
  const gamesWithFielderSnapshots = new Set(fielders.map((fielder) => String(fielder.game_id)))
  const gamesWithoutFielderSnapshots = [...new Set(
    pas
      .filter((pa) => !gamesWithFielderSnapshots.has(String(pa.game_id)))
      .map((pa) => String(pa.game_id)),
  )]
  observations.gamesWithoutFielderSnapshots.count = gamesWithoutFielderSnapshots.length
  observations.gamesWithoutFielderSnapshots.samples = gamesWithoutFielderSnapshots.slice(0, 20)

  const findFielder = (pa, positionNumber) => fielders.find((fielder) => (
    String(fielder.game_id) === String(pa.game_id)
    && Number(fielder.position) === Number(positionNumber)
    && fielderCoversPa(fielder, pa)
    && String(fielder.team_id) === String(pa.defensive_team_id)
  ))

  const noteMissingCredit = (type, pa, positionNumber, extra = {}) => {
    issues[type].count += 1
    pushSample(issues[type].samples, {
      pa_id: pa.id,
      game_id: pa.game_id,
      result: pa.result,
      inning: pa.inning,
      defensive_team_id: pa.defensive_team_id,
      position: positionNumber,
      notation: pa.error_notation || pa.hit_notation || null,
      ...extra,
    })
  }

  for (const pa of pas) {
    const { notation, positions, errorPosition } = parseFieldingSequence(pa)

    if (pa.is_error && errorPosition == null) {
      issues.missingErrorPosition.count += 1
      pushSample(issues.missingErrorPosition.samples, {
        pa_id: pa.id,
        game_id: pa.game_id,
        result: pa.result,
        notation,
        error_position: pa.error_position,
      })
    }

    if (pa.is_error && !pa.error_character) {
      issues.missingErrorCharacter.count += 1
      pushSample(issues.missingErrorCharacter.samples, {
        pa_id: pa.id,
        game_id: pa.game_id,
        result: pa.result,
        notation,
      })
    }

    if (pa.is_buddy_jump) {
      for (const position of [pa.buddy_jump_assist_position, pa.buddy_jump_putout_position].filter((value) => value != null && value !== '')) {
        if (!findFielder(pa, position)) {
          noteMissingCredit('missingBuddyJumpFielder', pa, position)
        }
      }
    }

    // No snapshot means there is no unambiguous character-to-position mapping
    // for this historical game. Keep PA-shape checks above, but do not report
    // invented catcher/assist/putout omissions as repairable integrity errors.
    if (!gamesWithFielderSnapshots.has(String(pa.game_id))) continue

    if (pa.is_error) {
      const errorIndex = errorPosition ? positions.lastIndexOf(errorPosition) : -1
      const assistPositions = errorIndex >= 0 ? positions.slice(0, errorIndex) : positions
      for (const position of new Set(assistPositions)) {
        if (!findFielder(pa, position)) {
          noteMissingCredit('missingFielderForCredit', pa, position, { credit: 'assist' })
        }
      }
      if (errorPosition != null && !findFielder(pa, errorPosition)) {
        noteMissingCredit('missingFielderForCredit', pa, errorPosition, { credit: 'error' })
      }
      continue
    }

    if (!positions.length) {
      if (pa.result === 'K' && !findFielder(pa, 2)) {
        noteMissingCredit('missingFielderForCredit', pa, 2, { credit: 'catcher_putout' })
      }
    } else {
      for (const position of new Set(positions.slice(0, -1))) {
        if (!findFielder(pa, position)) {
          noteMissingCredit('missingFielderForCredit', pa, position, { credit: 'assist' })
        }
      }
      const putoutPosition = positions[positions.length - 1]
      if (!findFielder(pa, putoutPosition)) {
        noteMissingCredit('missingFielderForCredit', pa, putoutPosition, { credit: 'putout' })
      }
    }

    const hitLocationOnlyNoOutContact = (
      !pa.is_error
      && positions.length === 0
      && pa.result !== 'K'
      && pa.hit_location != null
      && calculateOutsForPa(pa.result, pa.outs_on_play) === 0
    )
    if (hitLocationOnlyNoOutContact) {
      observations.safeContactRowsWithLocationOnly.count += 1
      pushSample(observations.safeContactRowsWithLocationOnly.samples, {
        pa_id: pa.id,
        game_id: pa.game_id,
        result: pa.result,
        hit_location: pa.hit_location,
        hit_notation: pa.hit_notation || null,
      })
    }
  }

  return { scope, totalPas: pas.length, totalFielders: fielders.length, observations, issues }
}

function sumIssueCounts(reportSection = {}) {
  return Object.values(reportSection.issues || {}).reduce((sum, issue) => sum + toNumber(issue.count), 0)
}

function buildSummary(report) {
  return {
    loaded: report.counts,
    tournament_pa_issues: sumIssueCounts(report.tournament.pa),
    season_pa_issues: sumIssueCounts(report.season.pa),
    tournament_pitching_issues: sumIssueCounts(report.tournament.pitching),
    season_pitching_issues: sumIssueCounts(report.season.pitching),
    tournament_fielding_issues: sumIssueCounts(report.tournament.fielding),
    season_fielding_issues: sumIssueCounts(report.season.fielding),
  }
}

async function main() {
  const options = parseArgs()
  let snapshot
  if (options.input) {
    if (!fs.existsSync(options.input)) throw new Error(`Input snapshot not found: ${options.input}`)
    snapshot = JSON.parse(fs.readFileSync(options.input, 'utf8'))
  } else {
    const envPath = path.resolve('.env')
    if (!fs.existsSync(envPath)) throw new Error('Missing .env file; pass --input for an offline audit.')
    const env = loadEnvFile(envPath)
    const url = env.VITE_SUPABASE_URL
    const anonKey = env.VITE_SUPABASE_ANON_KEY
    const bearerToken = process.env.SUPABASE_ACCESS_TOKEN || anonKey
    if (!url || !anonKey) throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY in .env.')
    const credentials = { url, anonKey, bearerToken }
    const tableSpecs = [
      ['players', { select: 'id,name', order: 'id.asc' }],
      ['season_teams', { select: 'id,player_id,season_id', order: 'id.asc' }],
      ['games', { select: '*', order: 'id.asc' }],
      ['season_schedule', { select: '*', order: 'id.asc' }],
      ['plate_appearances', { select: '*', order: 'id.asc' }],
      ['season_plate_appearances', { select: '*', order: 'id.asc' }],
      ['pitching_stints', { select: '*', order: 'id.asc' }],
      ['season_pitching_stints', { select: '*', order: 'id.asc' }],
      ['runs_scored', { select: '*', order: 'id.asc' }],
      ['season_runs_scored', { select: '*', order: 'id.asc' }],
      ['game_fielders', { select: '*', order: 'id.asc' }],
      ['season_game_fielders', { select: '*', order: 'id.asc' }],
      ['pitches', { select: '*', order: 'created_at.asc' }],
      ['season_pitches', { select: '*', order: 'created_at.asc' }],
    ]
    const rows = await Promise.all(tableSpecs.map(([table, spec]) => fetchAllRows(table, credentials, spec)))
    snapshot = Object.fromEntries(tableSpecs.map(([table], index) => [table, rows[index]]))
  }

  const players = snapshot.players || []
  const seasonTeams = snapshot.season_teams || []
  const games = snapshot.games || []
  const seasonSchedule = snapshot.season_schedule || []
  const plateAppearances = snapshot.plate_appearances || []
  const seasonPlateAppearances = snapshot.season_plate_appearances || []
  const pitchingStints = snapshot.pitching_stints || []
  const seasonPitchingStints = snapshot.season_pitching_stints || []
  const runsScored = snapshot.runs_scored || []
  const seasonRunsScored = snapshot.season_runs_scored || []
  const gameFielders = snapshot.game_fielders || []
  const seasonGameFielders = snapshot.season_game_fielders || []
  const pitches = snapshot.pitches || []
  const seasonPitches = snapshot.season_pitches || []

  const normalizedSeasonGames = normalizeSeasonGames(seasonSchedule, seasonTeams)
  const officialTournament = reconcileStatSource({
    games, plateAppearances, pitchingStints, runs: runsScored, gameFielders, pitches,
  })
  const officialSeason = reconcileStatSource({
    games: normalizedSeasonGames,
    plateAppearances: seasonPlateAppearances,
    pitchingStints: seasonPitchingStints,
    runs: seasonRunsScored,
    gameFielders: seasonGameFielders,
    pitches: seasonPitches,
  })
  const report = {
    generatedAt: new Date().toISOString(),
    input: options.input ? path.relative(process.cwd(), options.input) : 'supabase',
    counts: {
      players: players.length,
      season_teams: seasonTeams.length,
      games: games.length,
      season_schedule: seasonSchedule.length,
      plate_appearances: plateAppearances.length,
      season_plate_appearances: seasonPlateAppearances.length,
      pitching_stints: pitchingStints.length,
      season_pitching_stints: seasonPitchingStints.length,
      runs_scored: runsScored.length,
      season_runs_scored: seasonRunsScored.length,
      game_fielders: gameFielders.length,
      season_game_fielders: seasonGameFielders.length,
      pitches: pitches.length,
      season_pitches: seasonPitches.length,
    },
    selection: {
      tournament: officialTournament.coverage,
      season: officialSeason.coverage,
    },
    tournament: {
      pa: auditPlateAppearances({ scope: 'tournament', pas: officialTournament.plateAppearances, runs: officialTournament.runs }),
      pitching: auditPitching({ scope: 'tournament', games: officialTournament.games, pas: officialTournament.plateAppearances, stints: officialTournament.pitchingStints, runs: officialTournament.runs, pitches: officialTournament.pitches }),
      fielding: auditFielding({ scope: 'tournament', pas: officialTournament.plateAppearances, fielders: officialTournament.gameFielders }),
    },
    season: {
      pa: auditPlateAppearances({ scope: 'season', pas: officialSeason.plateAppearances, runs: officialSeason.runs }),
      pitching: auditPitching({ scope: 'season', games: officialSeason.games, pas: officialSeason.plateAppearances, stints: officialSeason.pitchingStints, runs: officialSeason.runs, pitches: officialSeason.pitches }),
      fielding: auditFielding({ scope: 'season', pas: officialSeason.plateAppearances, fielders: officialSeason.gameFielders }),
    },
  }

  report.summary = buildSummary(report)

  const outputPath = options.output
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2))

  console.log('Stats integrity audit complete.')
  console.log(JSON.stringify(report.summary, null, 2))
  console.log(`Detailed report written to ${outputPath}`)
}

main().catch((error) => {
  console.error(error?.message || error)
  process.exitCode = 1
})
