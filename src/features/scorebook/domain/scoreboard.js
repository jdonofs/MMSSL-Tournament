import { isCreditedHit } from '../../../utils/creditedHit.js'
import { DEFAULT_REGULATION_INNINGS, getFinalStatusLabel } from '../../../utils/gameRules.js'

export function normalizeStageLabel(stage = '') {
  if (stage.includes('CG-2')) return 'Championship Reset'
  if (stage.includes('CG-1')) return 'Championship'
  return stage
}

export function getPaScoringRuns(pa = {}, runsByPaId = {}) {
  const trackedRuns = runsByPaId[String(pa.id)] || []
  if (trackedRuns.length) return trackedRuns.length
  // The batter's run is already included in a home run's RBI total.
  const isHomer = pa.result === 'HR' || pa.result === 'IPHR'
  return Number(pa.rbi || 0) + (pa.run_scored && !isHomer ? 1 : 0)
}

export function runsThisHalfFromPAs(pas, playerId, inning, runs = []) {
  if (runs.length) {
    return runs.filter((run) => (
      String(run.scoring_player_id) === String(playerId)
      && Number(run.inning || 1) === Number(inning || 1)
    )).length
  }
  return pas
    .filter((pa) => String(pa.player_id) === String(playerId) && Number(pa.inning || 1) === Number(inning || 1))
    .reduce((sum, pa) => sum + getPaScoringRuns(pa), 0)
}

export function runsFromPAs(pas, playerId, runs = []) {
  if (runs.length) {
    return runs.filter((run) => String(run.scoring_player_id) === String(playerId)).length
  }
  return pas.filter(pa => pa.player_id === playerId)
    .reduce((sum, pa) => sum + getPaScoringRuns(pa), 0)
}

export function hitsFromPAs(pas, playerId) {
  return pas.filter((pa) => String(pa.player_id) === String(playerId) && isCreditedHit(pa)).length
}

export function errorsFromPAs(pas, playerId, opponentPlayerId) {
  return pas.filter((pa) => pa.is_error && String(pa.player_id) === String(opponentPlayerId)).length
}

export function inningRunsFromPAs(pas, playerId, runs = []) {
  const map = {}
  if (runs.length) {
    runs
      .filter((run) => String(run.scoring_player_id) === String(playerId))
      .forEach((run) => {
        const inning = Number(run.inning || 1)
        map[inning] = (map[inning] || 0) + 1
      })
    return map
  }
  pas.filter(pa => pa.player_id === playerId).forEach(pa => {
    map[pa.inning] = (map[pa.inning] || 0) + getPaScoringRuns(pa)
  })
  return map
}

export function inningRunsFromRows(rows, playerId) {
  const map = {}
  rows
    .filter((row) => String(row.player_id) === String(playerId))
    .forEach((row) => {
      const inning = Number(row.inning || 1)
      map[inning] = (map[inning] || 0) + Number(row.runs || 0)
    })
  return map
}

export function getLineScoreCellValue({ inning, side, scoreMap = {}, completedHalfCount = 0 }) {
  const inningRuns = scoreMap[inning]
  if (inningRuns != null) return inningRuns
  const halfIndex = (inning - 1) * 2 + (side === 'home' ? 1 : 0)
  return halfIndex < completedHalfCount ? 0 : '-'
}

export function formatGameStatusLabel(game, status, halfLabel = '', regulationInnings = DEFAULT_REGULATION_INNINGS) {
  if (status === 'complete') return getFinalStatusLabel(game, regulationInnings)
  if (status === 'active') return halfLabel || 'Live'
  if (status === 'pending') return 'Pregame'
  return status || 'Game'
}
