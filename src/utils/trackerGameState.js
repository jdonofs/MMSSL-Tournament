import { calculateOutsForPa } from './statsCalculator'
import { deriveOffense } from './gameRules'
import { computePendingState, computePendingOutState, extractNextRunners, normalizeStoredRunnerAssignments } from './runnerAssignment'

const HOLDS_RUNNERS = new Set(['K'])
const CLEARS_BASES = new Set(['HR', 'IPHR', 'TP'])
const HIT_LIKE = new Set(['1B', '2B', '3B', 'BB', 'HBP', 'ROE'])
const OUT_LIKE = new Set(['GO', 'FO', 'LO', 'SF', 'SH', 'DP', 'FC'])

function runnerKey(runner) {
  return runner ? `${runner.characterId}:${runner.playerId}` : null
}

// The generic default advance (e.g. a single sends a runner from 2nd only to
// 3rd, not home) is a guess — real games routinely score a runner from 2nd
// on a single depending on how it's hit. runs_scored rows are ground truth
// for exactly WHO scored on a given PA (the batter's own scoring engine
// already records them by name), so once the default assignment is computed,
// clear any pre-play occupant who's a confirmed scorer off whatever base the
// default guess left them on, instead of trusting the guess over the fact.
function applyKnownScorers(nextRunners, scorerKeys) {
  if (!scorerKeys || !scorerKeys.size) return nextRunners
  const result = { ...nextRunners }
  for (const base of ['first', 'second', 'third']) {
    // A scoring runner ends up on whatever base the default guess landed
    // them on — not necessarily the same base key they started the play on
    // (that's the whole point of advancing) — so this only needs to check
    // where they ended up, not where they started.
    if (result[base] && scorerKeys.has(runnerKey(result[base]))) {
      result[base] = null
    }
  }
  return result
}

// Replay one completed PA's runner movement. Newly edited PAs carry the exact
// assignments; legacy rows fall back to the old result-based reconstruction
// plus their runs_scored ledger.
function replayOnePa(pa, runners, scorerKeys) {
  const batterRunner = { characterId: pa.character_id, playerId: pa.player_id }
  if (CLEARS_BASES.has(pa.result)) return { first: null, second: null, third: null }
  if (HOLDS_RUNNERS.has(pa.result)) return runners
  const storedAssignments = normalizeStoredRunnerAssignments(pa.runner_assignments)
  if (storedAssignments) return extractNextRunners({ assignments: storedAssignments })
  if (HIT_LIKE.has(pa.result)) return applyKnownScorers(extractNextRunners(computePendingState(pa.result, runners, batterRunner)), scorerKeys)
  if (OUT_LIKE.has(pa.result)) return applyKnownScorers(extractNextRunners(computePendingOutState(pa.result, runners, batterRunner)), scorerKeys)
  return runners
}

// Given the full ordered list of a game's plate_appearances and the game row,
// derive the state of the game immediately BEFORE the PA at `index` (pass
// pas.length for "the current/live state, after everything recorded so
// far"). This is the single source of truth the tracker editor uses instead
// of a separately-tracked pointer — see runnerAssignment.js / this file's
// module-level comment for why runner identity is only best-effort.
export function deriveGameStateAtIndex(pas, game, lineups, index, runsScored = []) {
  const priorPAs = pas.slice(0, index)
  const outsBefore = priorPAs.reduce((sum, pa) => sum + calculateOutsForPa(pa.result, pa.outs_on_play), 0)
  const offense = deriveOffense(game, outsBefore)

  const scorerKeysByPaId = new Map()
  for (const run of runsScored) {
    const key = String(run.pa_id)
    if (!scorerKeysByPaId.has(key)) scorerKeysByPaId.set(key, new Set())
    scorerKeysByPaId.get(key).add(`${run.scoring_character_id}:${run.scoring_player_id}`)
  }

  // A half-inning always starts with the bases empty, so only PAs from the
  // start of the CURRENT half-inning onward need replaying — everything
  // before that only matters for the running outs count that located it.
  const halfInningStart = Math.floor(outsBefore / 3) * 3
  let runners = { first: null, second: null, third: null }
  let runningOuts = 0
  for (const pa of priorPAs) {
    if (runningOuts >= halfInningStart) {
      runners = replayOnePa(pa, runners, scorerKeysByPaId.get(String(pa.id)))
    }
    runningOuts += calculateOutsForPa(pa.result, pa.outs_on_play)
  }

  const currentLineup = lineups
    .filter((l) => String(l.player_id) === String(offense.battingPlayerId))
    .slice()
    .sort((a, b) => Number(a.batting_order || 0) - Number(b.batting_order || 0))
  const teamPaCount = priorPAs.filter((pa) => String(pa.player_id) === String(offense.battingPlayerId)).length
  const battingIdx = currentLineup.length ? teamPaCount % currentLineup.length : 0
  const batter = currentLineup[battingIdx] || null
  const onDeck = currentLineup.length ? currentLineup[(battingIdx + 1) % currentLineup.length] : null

  const defensiveLineup = lineups
    .filter((l) => String(l.player_id) === String(offense.pitchingPlayerId))
    .slice()
    .sort((a, b) => Number(a.batting_order || 0) - Number(b.batting_order || 0))

  return {
    inning: offense.inning,
    isTop: offense.isTop,
    halfLabel: offense.halfLabel,
    battingPlayerId: offense.battingPlayerId,
    pitchingPlayerId: offense.pitchingPlayerId,
    outsBefore,
    outsInHalf: outsBefore % 3,
    runnersBefore: runners,
    currentLineup,
    defensiveLineup,
    batter,
    onDeck,
    battingIdx,
  }
}
