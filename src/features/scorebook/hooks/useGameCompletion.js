import { useCallback, useEffect, useRef, useState } from 'react'
import { getPersistedLiveStateValue } from '../domain/liveState'
import {
  buildGameCompletionPatch,
  buildGameReopenPatch,
  buildGameResetPatch,
  resolveGameCompletionDetails,
} from '../domain/gameLifecycle'
import {
  countGameScopedRows,
  deleteGameScopedRows,
  updateGameRecord,
} from '../services/gameService'
import {
  auditGameFollowUps,
  finishCompletedGame,
  finishReopenedGame,
  writeCompletedGameStatus,
  writeReopenedGameStatus,
} from '../services/lifecycleService'
import { stopLocalTrackerForGame } from '../services/localTrackerControl'

export default function useGameCompletion({
  betResolutionConfig,
  canManageLifecycle,
  charactersById,
  currentInning,
  gameSession,
  isCommissioner,
  isGameComplete,
  isSeasonGame,
  playersById,
  pushToast,
  refreshGameData,
  regulationInnings,
  scorebookTables,
  scores,
  selectedGame,
  setGameEndBanner,
  setGames,
  setShowOutsBanner,
}) {
  const [showReopenGameConfirm, setShowReopenGameConfirm] = useState(false)
  const [showResetGameConfirm, setShowResetGameConfirm] = useState(false)
  const [resetGameBusy, setResetGameBusy] = useState(false)

  // Put a game back to never-played. Built for the auto-team/tracker loop,
  // where one fixture gets replayed over and over and every run leaves plate
  // appearances, odds, fielder rows and a populated live_state behind — which
  // the NEXT run then resumes from, so the second attempt never starts clean
  // and the failure looks like a bug in whatever is being tested.
  //
  // Deliberately not "reopen". Reopening un-finishes a game and keeps its
  // history; this throws the history away.
  const resetGameForTesting = useCallback(async () => {
    if (!selectedGame || !isCommissioner) return
    setResetGameBusy(true)
    try {
      // Children before parents. The ledger references bets, pitches
      // reference plate appearances — deleting a parent first either trips a
      // foreign key or strands rows, depending how each table was declared.
      // Betting tables are included in the preflight, but a real bet stops the
      // reset before anything is deleted. Empty tables are skipped so the
      // client never attempts a DELETE it is not permitted to perform.
      const ordered = [
        scorebookTables.trackerLiveStats,
        scorebookTables.bettingLedger,
        scorebookTables.bets,
        scorebookTables.settlements,
        scorebookTables.gameOdds,
        scorebookTables.pitches,
        scorebookTables.runsScored,
        scorebookTables.plateAppearances,
        scorebookTables.pitchingStints,
        scorebookTables.gameFielders,
        scorebookTables.lineups,
        scorebookTables.inningScores,
        scorebookTables.stadiumGameLog,
      ].filter(Boolean)
      // Count everything first, and delete nothing yet. Two reasons to look
      // before touching anything:
      //
      // season_bets grants no DELETE to ordinary roles at all, so firing one
      // at a game with no bets failed with "permission denied" and abandoned
      // the whole reset over a table that was empty. Skipping empty tables
      // means the common case — a test fixture nobody bet on — never goes
      // near it.
      //
      // And a game with real bets on it should not be half-dismantled before
      // anyone notices they are in the way. Refusing up front leaves the game
      // exactly as it was; refusing halfway would leave its plate appearances
      // deleted and its wagers pointing at a game that no longer has any.
      const counts = new Map()
      for (const table of ordered) {
        const { count, error } = await countGameScopedRows({ table, gameId: selectedGame.id })
        if (error) throw new Error(`${table} could not be read: ${error.message}. Nothing was changed.`)
        if (count) counts.set(table, count)
      }
      if (counts.has(scorebookTables.bets)) {
        throw new Error(
          `This game has ${counts.get(scorebookTables.bets)} bet(s) on it. Void or `
          + 'settle them first — resetting would leave wagers pointing at a game '
          + 'that never happened. Nothing was changed.',
        )
      }

      // Stop all local writers before deleting rows. The first count pass is
      // only a preflight; refresh it after shutdown so no late row is missed.
      await stopLocalTrackerForGame({
        gameId: selectedGame.id,
        table: isSeasonGame ? 'season_schedule' : 'games',
      })
      counts.clear()
      for (const table of ordered) {
        const { count, error } = await countGameScopedRows({ table, gameId: selectedGame.id })
        if (error) throw new Error(`${table} could not be read after stopping the tracker: ${error.message}. Nothing was changed.`)
        if (count) counts.set(table, count)
      }
      if (counts.has(scorebookTables.bets)) {
        throw new Error('A bet was placed while the tracker was stopping. Clear it before resetting. Nothing was changed.')
      }
  
      for (const [table, count] of counts) {
        const { error } = await deleteGameScopedRows({ table, gameId: selectedGame.id })
        if (error) {
          throw new Error(
            `${table} (${count} row(s)): ${error.message}. The reset stopped part `
            + 'way through, so this game is now incomplete — clear the rest by hand '
            + 'before playing it.',
          )
        }
        const { count: remaining, error: verifyError } = await countGameScopedRows({ table, gameId: selectedGame.id })
        if (verifyError) throw new Error(`${table} could not be verified after deletion: ${verifyError.message}. The reset is incomplete.`)
        if (remaining) throw new Error(`${table} still has ${remaining} row(s) for this game after deletion. The reset is incomplete; the game status was not changed.`)
      }
  
      // The two sources spell "not played yet" differently, and season games
      // hold their scores in null-able columns while tournament games use 0.
      // live_state is NOT NULL — a pristine row holds {}, not null.
      const { error: gameError } = await updateGameRecord({
        tables: scorebookTables,
        gameId: selectedGame.id,
        patch: buildGameResetPatch({ isSeasonGame }),
      })
      if (gameError) throw gameError

      try {
        window.sessionStorage.removeItem(`sluggers-game-started:${isSeasonGame ? 'season_schedule' : 'games'}:${selectedGame.id}`)
      } catch { /* Session storage may be disabled. */ }
  
      // Reload rather than patching state. The scorebook loader deliberately
      // keeps its local rows when a refetch comes back empty (so a lagging
      // replica cannot blank a lineup mid-game) — which is exactly wrong
      // here, because empty is now the truth. A reload is the one way to be
      // sure nothing survives in memory that no longer exists in the database.
      window.location.reload()
    } catch (error) {
      setResetGameBusy(false)
      setShowResetGameConfirm(false)
      pushToast({ title: 'Reset failed', message: error.message, type: 'error' })
    }
  }, [selectedGame, isCommissioner, scorebookTables, isSeasonGame, pushToast])

  // ── Completion and reopen follow-ups ───────────────────────────────────────
  // The status write and what follows it are separate on purpose. The write is
  // a compare-and-set on the row; everything after it (stadium log, bets, W/L/S,
  // standings/bracket) is done by utils/gameCompletionLifecycle from the rows in
  // the database, and is safe to run again. What is still owed is worked out
  // from those same rows, so the recovery banner comes back after a reload or
  // on another device -- it does not depend on this page remembering that
  // something failed.
  const lifecycleOptions = useCallback(() => ({
    sourceType: isSeasonGame ? 'season' : 'tournament',
    tables: scorebookTables,
    gameId: selectedGame?.id,
    betConfig: betResolutionConfig,
    charactersById,
    playersById,
  }), [isSeasonGame, scorebookTables, selectedGame?.id, betResolutionConfig, charactersById, playersById])

  const lifecycleBusyRef = useRef(false)
  const [lifecycleRunning, setLifecycleRunning] = useState(false)
  const [lifecycleAudit, setLifecycleAudit] = useState(null)
  const auditRequestRef = useRef(0)

  const auditLifecycle = useCallback(async () => {
    if (!selectedGame?.id || !canManageLifecycle) return null
    const request = ++auditRequestRef.current
    const gameId = selectedGame.id
    try {
      const result = await auditGameFollowUps(lifecycleOptions())
      if (request === auditRequestRef.current) setLifecycleAudit({ gameId, ...result, error: null })
      return result
    } catch (error) {
      if (request === auditRequestRef.current) setLifecycleAudit({ gameId, kind: null, owed: [], error })
      return null
    }
  }, [selectedGame?.id, canManageLifecycle, lifecycleOptions])

  // Re-checked whenever the persisted status changes (here, by realtime from
  // another device, or by the tracker bridge), and every 15 s while something
  // is still owed, so work another writer finishes clears the banner.
  // Keyed on the game and its status only; the latest callback is read through
  // a ref so a re-created prop object cannot turn this into a request loop.
  const auditOwedCount = lifecycleAudit?.gameId === selectedGame?.id ? (lifecycleAudit?.owed?.length || 0) : 0
  const auditLifecycleRef = useRef(auditLifecycle)
  auditLifecycleRef.current = auditLifecycle
  useEffect(() => {
    if (!selectedGame?.id || !canManageLifecycle) return undefined
    auditLifecycleRef.current()
    return () => { auditRequestRef.current += 1 }
  }, [selectedGame?.id, selectedGame?.status, canManageLifecycle])
  useEffect(() => {
    if (!auditOwedCount || lifecycleRunning) return undefined
    const timer = setInterval(() => { auditLifecycleRef.current() }, 15000)
    return () => clearInterval(timer)
  }, [auditOwedCount, lifecycleRunning])

  const applyChangedGames = useCallback((changedGames = []) => {
    if (!changedGames.length) return
    setGames((current) => {
      const existingById = new Map(current.map((game) => [game.id, game]))
      changedGames.forEach((game) => existingById.set(game.id, { ...(existingById.get(game.id) || {}), ...game }))
      return Array.from(existingById.values())
    })
  }, [setGames])

  const reportFollowUps = useCallback((result, { doneTitle, stepsName, retryLabel }) => {
    if (result.outcome === 'done') {
      pushToast({ title: doneTitle, type: 'success' })
      return
    }
    if (result.outcome === 'superseded' || result.outcome === 'not_complete') {
      pushToast({
        title: 'Game status changed',
        message: `The game is now ${result.game?.status || 'in a different state'}, so its ${stepsName} were stopped. The banner above the scorebook shows anything left to do.`,
        type: 'error',
      })
      return
    }
    const failed = result.failed.map((step) => `${step.label}: ${step.message}`).join('; ')
    pushToast({
      title: `${doneTitle}, but ${result.failed.length} ${stepsName} did not finish`,
      message: `${failed}. Use "${retryLabel}" to retry; steps that already finished are left alone.`,
      type: 'error',
    })
  }, [pushToast])

  const settleLocalState = useCallback(async (result) => {
    applyChangedGames(result.changedGames)
    await Promise.resolve(refreshGameData?.()).catch(() => {})
    await Promise.resolve(gameSession?.onLifecycleSettled?.()).catch(() => {})
  }, [applyChangedGames, refreshGameData, gameSession])

  const runCompletionFollowUps = useCallback(async ({ doneTitle = 'Game complete' } = {}) => {
    let result
    try {
      result = await finishCompletedGame(lifecycleOptions())
    } catch (error) {
      pushToast({ title: 'Completion steps could not start', message: `${error.message}. Use "Finish completion steps" to retry.`, type: 'error' })
      return null
    }
    await settleLocalState(result)
    reportFollowUps(result, { doneTitle, stepsName: 'completion step(s)', retryLabel: 'Finish completion steps' })
    return result
  }, [lifecycleOptions, settleLocalState, reportFollowUps, pushToast])

  const runReopenFollowUps = useCallback(async ({ doneTitle = 'Game reopened' } = {}) => {
    let result
    try {
      result = await finishReopenedGame(lifecycleOptions())
    } catch (error) {
      pushToast({ title: 'Reopen steps could not start', message: `${error.message}. Use "Finish reopening" to retry.`, type: 'error' })
      return null
    }
    await settleLocalState(result)
    reportFollowUps(result, { doneTitle, stepsName: 'reopen step(s)', retryLabel: 'Finish reopening' })
    return result
  }, [lifecycleOptions, settleLocalState, reportFollowUps, pushToast])

  // One lifecycle action at a time from this page. This stops a double click;
  // it does not coordinate two devices -- the status compare-and-set and the
  // idempotent follow-ups are what make overlapping clients converge.
  const withLifecycleLock = useCallback(async (work) => {
    if (lifecycleBusyRef.current) return null
    lifecycleBusyRef.current = true
    setLifecycleRunning(true)
    try {
      return await work()
    } finally {
      lifecycleBusyRef.current = false
      setLifecycleRunning(false)
      auditLifecycle()
    }
  }, [auditLifecycle])

  // ── Mark game complete ─────────────────────────────────────────────────────
  const markGameComplete = useCallback((winnerId, finalInning, isExtra) => withLifecycleLock(async () => {
    if (!selectedGame) return
    const {
      resolvedWinnerId: resolved,
      resolvedFinalInning,
      resolvedIsExtra,
    } = resolveGameCompletionDetails({
      winnerId,
      finalInning,
      isExtra,
      scores,
      selectedGame,
      currentInning,
      regulationInnings,
    })
    // The transient walk-off banner passes isExtra explicitly, but a reload
    // removes that banner and leaves the generic End Game action. Infer the
    // flag from the persisted inning in that path so an inning-4 finish in a
    // three-inning game cannot be finalized as a regulation game.
    const clearedLiveState = getPersistedLiveStateValue(null, true)
    const completionUpdate = buildGameCompletionPatch({
      isSeasonGame,
      winnerId: resolved,
      scores,
      finalInning: resolvedFinalInning,
      isExtra: resolvedIsExtra,
      teamIdByPlayerId: gameSession.teamIdByPlayerId,
      clearedLiveState,
    })
    const write = await writeCompletedGameStatus({
      sourceType: isSeasonGame ? 'season' : 'tournament',
      tables: scorebookTables,
      gameId: selectedGame.id,
      patch: completionUpdate,
    })
    if (write.error) { pushToast({ title: 'Error', message: write.error.message, type: 'error' }); return }
    // Written here, or already final (another device, the tracker, or this
    // write whose response was lost). The row in the database is the result
    // either way, and the follow-ups read it rather than this page's score.
    const completedGame = write.applied
      ? {
          ...selectedGame,
          status: 'complete',
          winner_player_id: resolved,
          team_a_runs: scores.a,
          team_b_runs: scores.b,
          final_inning: resolvedFinalInning,
          is_extra_innings: resolvedIsExtra,
          live_state: clearedLiveState,
        }
      : { ...selectedGame, status: 'complete' }
    setGames(cur => cur.map(g => g.id === selectedGame.id ? completedGame : g))
    setGameEndBanner(null)
    if (write.alreadyComplete) {
      pushToast({ title: 'Already final', message: 'This game had already been completed, so only its follow-up steps were checked.', type: 'info' })
    }
    await runCompletionFollowUps()
  }), [withLifecycleLock, selectedGame, scores, currentInning, regulationInnings, isSeasonGame, gameSession, scorebookTables, pushToast, setGames, setGameEndBanner, runCompletionFollowUps])

  const reopenCompletedGame = useCallback(() => withLifecycleLock(async () => {
    if (!selectedGame || !isGameComplete) return

    const clearedLiveState = getPersistedLiveStateValue(null, true)
    const reopenUpdate = buildGameReopenPatch({ isSeasonGame, scores, clearedLiveState })

    // The status moves first so the betting tab's recovery pass (which
    // settles complete games with open bets) cannot re-settle a game this is
    // reversing. A failure here leaves the confirm open to try again.
    const write = await writeReopenedGameStatus({
      sourceType: isSeasonGame ? 'season' : 'tournament',
      tables: scorebookTables,
      gameId: selectedGame.id,
      patch: reopenUpdate,
    })
    if (write.error) {
      pushToast({ title: 'Reopen failed', message: write.error.message, type: 'error' })
      return
    }

    const reopenedGame = {
      ...selectedGame,
      status: 'active',
      winner_player_id: null,
      team_a_runs: scores.a,
      team_b_runs: scores.b,
      final_inning: null,
      is_extra_innings: false,
      live_state: clearedLiveState,
    }
    setGames((current) => current.map((game) => (game.id === selectedGame.id ? reopenedGame : game)))
    setShowReopenGameConfirm(false)
    setGameEndBanner(null)
    setShowOutsBanner(false)
    await runReopenFollowUps()
  }), [withLifecycleLock, selectedGame, isGameComplete, isSeasonGame, scores, scorebookTables, pushToast, setGames, setGameEndBanner, setShowOutsBanner, runReopenFollowUps])

  // The recovery control: finish whatever the game's persisted status still
  // owes. It is offered whenever the audit finds owed work, which does not
  // depend on the status having just been changed from this page.
  const finishLifecycleFollowUps = useCallback(() => withLifecycleLock(async () => {
    const audit = await auditLifecycle()
    if (audit?.kind === 'completion') return runCompletionFollowUps({ doneTitle: 'Completion steps finished' })
    if (audit?.kind === 'reopen') return runReopenFollowUps({ doneTitle: 'Reopen finished' })
    return null
  }), [withLifecycleLock, auditLifecycle, runCompletionFollowUps, runReopenFollowUps])

  const currentAudit = lifecycleAudit?.gameId === selectedGame?.id ? lifecycleAudit : null

  return {
    lifecycleRecovery: {
      audit: currentAudit,
      running: lifecycleRunning,
      finish: finishLifecycleFollowUps,
      recheck: auditLifecycle,
    },
    markGameComplete,
    reopenCompletedGame,
    resetGameForTesting,
    resetGameBusy,
    setShowReopenGameConfirm,
    setShowResetGameConfirm,
    showReopenGameConfirm,
    showResetGameConfirm,
  }
}
