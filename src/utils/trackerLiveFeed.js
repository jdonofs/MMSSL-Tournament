function cleanTeamName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ')
}

function teamNamesMatch(scoreName, mappedName) {
  const score = cleanTeamName(scoreName).toLocaleLowerCase()
  const mapped = cleanTeamName(mappedName).toLocaleLowerCase()
  if (!score || !mapped) return false
  return score === mapped || score.endsWith(` ${mapped}`) || mapped.endsWith(` ${score}`)
}

function normalizeSide(value) {
  const side = String(value || '').trim().toUpperCase()
  return side === 'A' || side === 'B' ? side : null
}

export function resolveTrackerScore({
  trackerStats = null,
  teamAPlayerId = null,
  teamBPlayerId = null,
} = {}) {
  const feed = trackerStats?.live_feed && typeof trackerStats.live_feed === 'object'
    ? trackerStats.live_feed
    : {}
  const score = feed.score && typeof feed.score === 'object' ? feed.score : {}
  const scoreBySide = feed.scoreBySide && typeof feed.scoreBySide === 'object'
    ? feed.scoreBySide
    : {}
  const scoreNames = Object.keys(score)
  const knownSides = new Map()

  Object.entries(trackerStats?.team_mapping || {}).forEach(([name, side]) => {
    const normalizedSide = normalizeSide(side)
    if (normalizedSide) knownSides.set(cleanTeamName(name), normalizedSide)
  })

  Object.entries(feed.alignments || {}).forEach(([playerId, alignment]) => {
    const side = String(playerId) === String(teamAPlayerId)
      ? 'A'
      : String(playerId) === String(teamBPlayerId) ? 'B' : null
    if (side && alignment?.teamName) knownSides.set(cleanTeamName(alignment.teamName), side)
  })

  const gameInfo = trackerStats?.game_info || {}
  if (gameInfo['Away Team']) knownSides.set(cleanTeamName(gameInfo['Away Team']), 'A')
  if (gameInfo['Home Team']) knownSides.set(cleanTeamName(gameInfo['Home Team']), 'B')

  const sideByScoreName = {}
  scoreNames.forEach((scoreName) => {
    const matches = [...knownSides.entries()]
      .filter(([knownName]) => teamNamesMatch(scoreName, knownName))
      .map(([, side]) => side)
    const uniqueMatches = [...new Set(matches)]
    if (uniqueMatches.length === 1) sideByScoreName[scoreName] = uniqueMatches[0]
  })

  // Once one club is identified, a two-team score feed makes the other side
  // unambiguous. This also handles a commissioner mapping only one team.
  if (scoreNames.length === 2) {
    const assigned = scoreNames.filter((name) => sideByScoreName[name])
    if (assigned.length === 1) {
      const otherName = scoreNames.find((name) => !sideByScoreName[name])
      sideByScoreName[otherName] = sideByScoreName[assigned[0]] === 'A' ? 'B' : 'A'
    }
  }

  const teamAName = scoreNames.find((name) => sideByScoreName[name] === 'A') || null
  const teamBName = scoreNames.find((name) => sideByScoreName[name] === 'B') || null
  const sideATotal = scoreBySide.a ?? scoreBySide.A
  const sideBTotal = scoreBySide.b ?? scoreBySide.B
  const namedTeamARuns = teamAName != null && Number.isFinite(Number(score[teamAName]))
    ? Number(score[teamAName])
    : null
  const namedTeamBRuns = teamBName != null && Number.isFinite(Number(score[teamBName]))
    ? Number(score[teamBName])
    : null
  // The bridge updates side totals on every run. Named tracker score lines are
  // only emitted between half innings, so they are a compatibility fallback
  // and must never override the more current side-keyed total.
  const teamARuns = sideATotal != null && Number.isFinite(Number(sideATotal))
    ? Number(sideATotal)
    : namedTeamARuns
  const teamBRuns = sideBTotal != null && Number.isFinite(Number(sideBTotal))
    ? Number(sideBTotal)
    : namedTeamBRuns

  return { teamARuns, teamBRuns, teamAName, teamBName, sideByScoreName }
}

export function applyTrackerLiveStateToGame(game, trackerStats, options = {}) {
  if (!game || !trackerStats) return game
  const {
    isSeason = false,
    teamAPlayerId = game.team_a_player_id,
    teamBPlayerId = game.team_b_player_id,
  } = options
  const feed = trackerStats.live_feed && typeof trackerStats.live_feed === 'object'
    ? trackerStats.live_feed
    : {}
  const resolvedScore = resolveTrackerScore({ trackerStats, teamAPlayerId, teamBPlayerId })
  const scoreBySide = feed.scoreBySide && typeof feed.scoreBySide === 'object' ? feed.scoreBySide : {}
  const hasSideATotal = (scoreBySide.a ?? scoreBySide.A) != null
  const hasSideBTotal = (scoreBySide.b ?? scoreBySide.B) != null
  const gameTeamARuns = Number(isSeason ? game.away_score : game.team_a_runs)
  const gameTeamBRuns = Number(isSeason ? game.home_score : game.team_b_runs)
  const isLegacyReset = /^Rematch detected\./i.test(String(feed.lastEvent || ''))
  // Compatibility for an already-running pre-fix bridge: its game row moves
  // on every run but its named snapshot only moves at a side change. Scores
  // are monotonic within a game, so the higher value prevents that stale
  // snapshot from pulling 3-2 back to 3-0. A rematch/reset deliberately uses
  // the newly reset game row. New bridge snapshots use scoreBySide directly.
  const teamARuns = hasSideATotal
    ? resolvedScore.teamARuns
    : isLegacyReset && Number.isFinite(gameTeamARuns)
      ? gameTeamARuns
      : Math.max(Number.isFinite(gameTeamARuns) ? gameTeamARuns : 0, resolvedScore.teamARuns ?? 0)
  const teamBRuns = hasSideBTotal
    ? resolvedScore.teamBRuns
    : isLegacyReset && Number.isFinite(gameTeamBRuns)
      ? gameTeamBRuns
      : Math.max(Number.isFinite(gameTeamBRuns) ? gameTeamBRuns : 0, resolvedScore.teamBRuns ?? 0)
  const persistedLiveState = game.live_state && typeof game.live_state === 'object' ? game.live_state : {}
  const feedRunners = feed.runners && typeof feed.runners === 'object' ? feed.runners : persistedLiveState.runners
  const liveState = {
    ...persistedLiveState,
    inning: Number(feed.inning ?? persistedLiveState.inning ?? 1),
    isTop: Boolean(feed.isTop ?? persistedLiveState.isTop ?? persistedLiveState.is_top ?? true),
    outsInHalf: Number(feed.outs ?? persistedLiveState.outsInHalf ?? persistedLiveState.outs_in_half ?? 0),
    balls: Number(feed.balls ?? persistedLiveState.balls ?? 0),
    strikes: Number(feed.strikes ?? persistedLiveState.strikes ?? 0),
    paNumber: Number(feed.paNumber ?? persistedLiveState.paNumber ?? persistedLiveState.pa_number ?? 0),
    batterCharacterId: persistedLiveState.batterCharacterId ?? persistedLiveState.batter_character_id ?? null,
    batterPlayerId: persistedLiveState.batterPlayerId ?? persistedLiveState.batter_player_id ?? null,
    pitcherCharacterId: persistedLiveState.pitcherCharacterId ?? persistedLiveState.pitcher_character_id ?? null,
    pitcherPlayerId: persistedLiveState.pitcherPlayerId ?? persistedLiveState.pitcher_player_id ?? null,
    runners: feedRunners || { first: null, second: null, third: null },
    updatedAt: trackerStats.updated_at || feed.lastEventAt || persistedLiveState.updatedAt || null,
  }

  const overlay = {
    ...game,
    live_state: liveState,
    current_inning: liveState.inning,
    is_top_inning: liveState.isTop,
    outs_in_half: liveState.outsInHalf,
    tracker_game_ended: Boolean(feed.gameEnded),
    tracker_updated_at: trackerStats.updated_at || null,
  }
  if (teamARuns != null) {
    overlay.team_a_runs = teamARuns
    if (isSeason) overlay.away_score = teamARuns
  }
  if (teamBRuns != null) {
    overlay.team_b_runs = teamBRuns
    if (isSeason) overlay.home_score = teamBRuns
  }
  return overlay
}

export function buildLiveMarketState(game, gamePAs = [], regulationInnings = null) {
  const live = game?.live_state && typeof game.live_state === 'object' ? game.live_state : {}
  const inningFromPAs = Math.max(1, ...(gamePAs || []).map((pa) => Number(pa.inning || 1)))
  const runners = live.runners && typeof live.runners === 'object' ? live.runners : {}
  return {
    homeScore: Number(game?.team_b_runs || 0),
    awayScore: Number(game?.team_a_runs || 0),
    currentInning: Number(live.inning ?? game?.current_inning ?? inningFromPAs),
    isTop: Boolean(live.isTop ?? live.is_top ?? game?.is_top_inning ?? true),
    outsInHalf: Number(live.outsInHalf ?? live.outs_in_half ?? game?.outs_in_half ?? 0),
    regulationInnings: Number(regulationInnings ?? game?.innings ?? 3),
    runnersOccupied: ['first', 'second', 'third'].filter((base) => Boolean(runners[base])).length,
    balls: Number(live.balls || 0),
    strikes: Number(live.strikes || 0),
    paCount: (gamePAs || []).length,
    status: game?.status === 'complete' ? 'complete' : game?.status === 'pending' || game?.status === 'scheduled' ? 'pending' : 'active',
  }
}

export function buildTrackerGameSignature(game, gamePAs = [], gamePitching = []) {
  const live = game?.live_state && typeof game.live_state === 'object' ? game.live_state : {}
  const paTail = (gamePAs || []).slice(-2).map((pa) => [pa.id, pa.result, pa.rbi, pa.run_scored, pa.outs_on_play].join(':')).join(',')
  // This signature drives the browser-side fallback odds writer. It must use
  // the same at-bat boundary as the tracker bridge: live count, raw pitch
  // totals and heartbeat timestamps update every pitch and are deliberately
  // excluded. Completed PA/pitching results and actual pitcher changes remain.
  const pitching = (gamePitching || []).map((stint) => [
    stint.id,
    stint.character_id,
    stint.innings_pitched,
    stint.hits_allowed,
    stint.runs_allowed,
    stint.walks,
    stint.strikeouts,
  ].join(':')).join(',')
  return [
    Number(game?.team_a_runs || 0),
    Number(game?.team_b_runs || 0),
    Number(live.inning ?? game?.current_inning ?? 1),
    Boolean(live.isTop ?? live.is_top ?? game?.is_top_inning ?? true),
    Number(live.outsInHalf ?? live.outs_in_half ?? 0),
    ['first', 'second', 'third'].map((base) => live.runners?.[base] ? '1' : '0').join(''),
    live.pitcherCharacterId ?? live.pitcher_character_id ?? '',
    live.pitcherPlayerId ?? live.pitcher_player_id ?? '',
    (gamePAs || []).length,
    paTail,
    pitching,
  ].join('|')
}

export function buildTrackerMarketInputSignature({
  scoreState = {},
  liveState = {},
  expectedPitcherByPlayer = {},
  completedPaRevision = 0,
} = {}) {
  const runnerKey = (runner) => runner
    ? `${runner.characterId ?? runner.character_id ?? ''}:${runner.playerId ?? runner.player_id ?? ''}`
    : ''
  const expectedPitchers = Object.entries(expectedPitcherByPlayer || {})
    .sort(([left], [right]) => String(left).localeCompare(String(right)))

  // Price live markets once per completed plate appearance, not once per
  // pitch. Deliberately excludes timestamps, events, count, pitch number,
  // batter and PA number. Menu/pause noise and the next batter being announced
  // must not cause a second price pass for the same completed at-bat.
  return JSON.stringify({
    score: [Number(scoreState.a || 0), Number(scoreState.b || 0)],
    inning: Number(liveState.inning || 1),
    isTop: liveState.isTop !== false,
    outs: Number(liveState.outsInHalf ?? liveState.outs_in_half ?? 0),
    runners: ['first', 'second', 'third'].map((base) => runnerKey(liveState.runners?.[base])),
    pitcher: [
      liveState.pitcherCharacterId ?? liveState.pitcher_character_id ?? '',
      liveState.pitcherPlayerId ?? liveState.pitcher_player_id ?? '',
    ],
    completedPaRevision: Number(completedPaRevision || 0),
    expectedPitchers,
  })
}
