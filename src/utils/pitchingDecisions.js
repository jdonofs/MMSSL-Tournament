import { outsFromInningsPitched } from './statsCalculator'

export function groupRunsByPaId(runs) {
  return runs.reduce((acc, run) => {
    const key = String(run.pa_id)
    ;(acc[key] ||= []).push(run)
    return acc
  }, {})
}

// Walks a game's plate appearances in order, tracking the running score and who's charged with
// each scoring play, so we can find exactly when (and to whom) the lead changed hands. This is
// the same "decisive play" reconstruction Scorebook.jsx's live pitcherDecisionSummary uses.
function buildScoringSummary(pas, runsByPaId) {
  let scoreA = 0
  let scoreB = 0
  let lastLeader = null
  const summary = []
  pas.forEach((pa) => {
    const runs = runsByPaId[String(pa.id)] || []
    const isHomer = pa.result === 'HR' || pa.result === 'IPHR'
    const scoringRuns = runs.length || (Number(pa.rbi || 0) + (pa.run_scored && !isHomer ? 1 : 0))
    if (!scoringRuns) return

    if (pa.side === 'A') scoreA += scoringRuns
    else scoreB += scoringRuns
    const leader = scoreA === scoreB ? null : scoreA > scoreB ? 'A' : 'B'
    const charged = runs[0]
      ? { characterId: runs[0].charged_to_pitcher_id ?? null, playerId: runs[0].charged_to_pitcher_player_id ?? null }
      : { characterId: pa.pitcherCharacterId ?? null, playerId: pa.pitcherPlayerId ?? null }

    summary.push({ createdAt: pa.createdAt, scoreA, scoreB, leader, leaderChanged: leader !== lastLeader, charged })
    lastLeader = leader
  })
  return summary
}

function latestStintFor(stints, side, atOrBefore) {
  const pool = stints.filter((s) => s.side === side && (atOrBefore == null || new Date(s.createdAt) <= atOrBefore))
  if (!pool.length) return null
  return pool.reduce((latest, s) => (new Date(s.createdAt) > new Date(latest.createdAt) ? s : latest))
}

// Derives winning/losing/save pitcher for one game from its play-by-play, honoring any
// win/loss/save flags already stamped on the stints (from a live-completed game or spreadsheet
// import) and only reconstructing what's missing. Most historical games here were bulk-imported
// or backfilled rather than finished through Scorebook's live "mark complete" button, so their
// stints were never flagged at all — this fills that gap using the actual official-scorer rules:
// the winning pitcher is whoever was pitching for the winning side when it took the lead for
// good, and the losing pitcher is whoever was charged with the run that handed the opponent that
// lead (not simply "whoever pitched last").
//
// `stints` entries need { characterId, playerId, side: 'A'|'B', createdAt, inningsPitched, win, loss, save }.
// `pas` entries need { id, side: 'A'|'B', createdAt, result, rbi, run_scored, pitcherCharacterId, pitcherPlayerId }.
// `runsByPaId` maps pa id -> run rows with charged_to_pitcher_id/charged_to_pitcher_player_id.
export function derivePitchingDecisions({ pas, runsByPaId, stints, winnerSide }) {
  let winStint = stints.find((s) => s.win) || null
  let lossStint = stints.find((s) => s.loss) || null
  let saveStint = stints.find((s) => s.save) || null
  const hadExplicitSave = Boolean(saveStint)

  if ((!winStint || !lossStint) && winnerSide) {
    const summary = buildScoringSummary(pas, runsByPaId)
    let decisivePlay = null
    summary.forEach((play) => {
      if (play.leaderChanged && play.leader === winnerSide) decisivePlay = play
    })

    if (!winStint) {
      winStint = (decisivePlay && latestStintFor(stints, winnerSide, new Date(decisivePlay.createdAt)))
        || latestStintFor(stints, winnerSide, null)
    }

    if (!lossStint && decisivePlay) {
      const loserSide = winnerSide === 'A' ? 'B' : 'A'
      const { charged } = decisivePlay
      const decisiveTime = new Date(decisivePlay.createdAt)
      // Match by character/player first, but a pitcher can have more than one stint in a game
      // (a re-entry, or an empty stint left behind by briefly reselecting them without recording
      // a PA) — picking the first stint in array order regardless of timing can grab a stint that
      // wasn't even active yet (or was created well after the fact) instead of the one actually on
      // the mound when the run scored. Restrict to the matching stints, then reuse the same
      // time-aware "latest eligible" pick the winStint lookup above already uses.
      const chargedCandidates = stints.filter((s) => (
        s.side === loserSide
        && ((charged.characterId != null && String(s.characterId) === String(charged.characterId))
          || (charged.characterId == null && charged.playerId != null && String(s.playerId) === String(charged.playerId)))
      ))
      lossStint = latestStintFor(chargedCandidates, loserSide, decisiveTime)
        || latestStintFor(chargedCandidates, loserSide, null)
        || latestStintFor(stints, loserSide, decisiveTime)
        || latestStintFor(stints, loserSide, null)
    }

    // Save (approximate): credit the pitcher who finished the game for the winning side, if
    // different from the winning pitcher, provided the winning side never lost the lead from the
    // moment that pitcher entered, and one of the two size-independent save rules is met (entered
    // up 1-3 runs and got at least a full inning, or covered at least 3 innings solo). The
    // "tying run on base/at bat/on deck" rule isn't modeled — it needs runner state this
    // reconstruction doesn't have.
    if (!hadExplicitSave) {
      const finishing = latestStintFor(stints, winnerSide, null)
      if (finishing && finishing !== winStint) {
        const priorPlay = [...summary].reverse().find((play) => new Date(play.createdAt) <= new Date(finishing.createdAt))
        const leadAtEntry = priorPlay ? (winnerSide === 'A' ? priorPlay.scoreA - priorPlay.scoreB : priorPlay.scoreB - priorPlay.scoreA) : 0
        const leadHeldThroughout = summary.every((play) => new Date(play.createdAt) < new Date(finishing.createdAt) || play.leader === winnerSide)
        const outs = outsFromInningsPitched(finishing.inningsPitched)
        const qualifies = leadHeldThroughout && ((leadAtEntry >= 1 && leadAtEntry <= 3 && outs >= 3) || outs >= 9)
        if (qualifies) saveStint = finishing
      }
    }
  }

  return { winStint, lossStint, saveStint }
}

function groupByGameId(rows) {
  return rows.reduce((acc, row) => {
    const key = String(row.game_id)
    ;(acc[key] ||= []).push(row)
    return acc
  }, {})
}

function toDecisionStints(rawStints, sideForPlayerId) {
  return rawStints.map((s) => ({
    id: s.id,
    characterId: s.character_id,
    playerId: s.player_id,
    side: sideForPlayerId(s.player_id),
    createdAt: s.created_at,
    inningsPitched: s.innings_pitched,
    win: s.win,
    loss: s.loss,
    save: s.save,
  }))
}

function toDecisionPas(rawPas, sideForPlayerId) {
  return rawPas
    .map((pa) => ({
      id: pa.id,
      side: sideForPlayerId(pa.player_id),
      createdAt: pa.created_at,
      paNumber: pa.pa_number,
      result: pa.result,
      rbi: pa.rbi,
      run_scored: pa.run_scored,
      pitcherCharacterId: pa.pitcher_id ?? null,
      pitcherPlayerId: pa.pitcher_player_id ?? null,
    }))
    .sort((a, b) => (Number(a.paNumber || 0) - Number(b.paNumber || 0)) || new Date(a.createdAt || 0) - new Date(b.createdAt || 0))
}

// Recomputes win/loss/save for every stint in `rawStints`, one game at a time, using
// `resolveGame(game)` to describe that game's two sides. Returns a new stints array — same rows,
// same ids, just with win/loss/save corrected — so any existing consumer that reads
// stint.win/loss/save (summarizePitching, character/team/roster/draft pages, etc.) gets the real
// decision without having to know about play-by-play reconstruction itself.
function resolvePitchingDecisionsForStints(rawStints, gamesById, rawPas, runsByPaId, resolveGame) {
  const stintsByGame = groupByGameId(rawStints)
  const pasByGame = groupByGameId(rawPas)
  const decisionsByGame = new Map()

  Object.keys(stintsByGame).forEach((gameId) => {
    const game = gamesById.get(gameId)
    if (!game) return
    const { winnerSide, sideForPlayerId } = resolveGame(game)
    if (!winnerSide) return

    const gameStints = toDecisionStints(stintsByGame[gameId], sideForPlayerId)
    const gamePas = toDecisionPas(pasByGame[gameId] || [], sideForPlayerId)
    const { winStint, lossStint, saveStint } = derivePitchingDecisions({ pas: gamePas, runsByPaId, stints: gameStints, winnerSide })
    decisionsByGame.set(gameId, { winId: winStint?.id ?? null, lossId: lossStint?.id ?? null, saveId: saveStint?.id ?? null })
  })

  return rawStints.map((s) => {
    const decision = decisionsByGame.get(String(s.game_id))
    if (!decision) return s
    return { ...s, win: s.id === decision.winId, loss: s.id === decision.lossId, save: s.id === decision.saveId }
  })
}

// Season variant: sides are the schedule row's home/away teams, resolved to their owning player.
export function resolveSeasonPitchingDecisions(stints, schedule, pas, runsByPaId, seasonTeamPlayerIdByTeamId) {
  const gamesById = new Map(schedule.map((g) => [String(g.id), g]))
  return resolvePitchingDecisionsForStints(stints, gamesById, pas, runsByPaId, (g) => {
    const homePlayerId = seasonTeamPlayerIdByTeamId[String(g.home_team_id)]
    const awayPlayerId = seasonTeamPlayerIdByTeamId[String(g.away_team_id)]
    const winnerSide = g.winner_team_id != null
      ? (String(g.winner_team_id) === String(g.away_team_id) ? 'A' : String(g.winner_team_id) === String(g.home_team_id) ? 'B' : null)
      : null
    return { winnerSide, sideForPlayerId: (pid) => (String(pid) === String(awayPlayerId) ? 'A' : String(pid) === String(homePlayerId) ? 'B' : null) }
  })
}

// Tournament variant: sides are the game row's team_a/team_b player ids directly.
export function resolveTournamentPitchingDecisions(stints, games, pas, runsByPaId) {
  const gamesById = new Map(games.map((g) => [String(g.id), g]))
  return resolvePitchingDecisionsForStints(stints, gamesById, pas, runsByPaId, (g) => {
    const winnerSide = g.winner_player_id != null
      ? (String(g.winner_player_id) === String(g.team_a_player_id) ? 'A' : String(g.winner_player_id) === String(g.team_b_player_id) ? 'B' : null)
      : null
    return { winnerSide, sideForPlayerId: (pid) => (String(pid) === String(g.team_a_player_id) ? 'A' : String(pid) === String(g.team_b_player_id) ? 'B' : null) }
  })
}
