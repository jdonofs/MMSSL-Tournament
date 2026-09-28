import { useCallback, useState } from 'react'
import { isCreditedHit } from '../../../utils/statsCalculator'
import { buildBettingEntityLabel } from '../../../utils/oddsEngine'
import {
  getBettingWinningSide,
  reopenGameBets,
  resolveGameBets,
} from '../../../utils/betResolution'
import { decideGamePitchingFlags } from '../../../utils/pitchingDecisions'
import { getPersistedLiveStateValue } from '../domain/liveState'
import {
  buildGameCompletionPatch,
  buildGameReopenPatch,
  buildGameResetPatch,
  resolveGameCompletionDetails,
} from '../domain/gameLifecycle'
import {
  clearPitchingStintDecisions,
  clearTournamentCompletion,
  countGameScopedRows,
  deleteGameScopedRows,
  deleteStadiumGameLog,
  insertStadiumGameLog,
  updateGameRecord,
  updatePitchingStint,
} from '../services/gameService'
import {
  advanceTournamentBracket,
  reopenTournamentBracket,
} from '../services/bracketService'
import { stopLocalTrackerForGame } from '../services/localTrackerControl'

export default function useGameCompletion({
  betResolutionConfig,
  charactersById,
  currentInning,
  gamePAs,
  gamePitching,
  gameRuns,
  games,
  gameSession,
  isCommissioner,
  isGameComplete,
  isSeasonGame,
  playersById,
  pushToast,
  regulationInnings,
  scorebookTables,
  scores,
  selectedGame,
  selectedStadium,
  setGameEndBanner,
  setGames,
  setPitchingStints,
  setShowOutsBanner,
  tournament,
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

  // ── Mark game complete ─────────────────────────────────────────────────────
  const markGameComplete = useCallback(async (winnerId, finalInning, isExtra) => {
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
    const { error } = await updateGameRecord({ tables: scorebookTables, gameId: selectedGame.id, patch: completionUpdate })
    if (error) { pushToast({ title: 'Error', message: error.message, type: 'error' }); return }
    const completedGame = {
      ...selectedGame,
      status: 'complete',
      winner_player_id: resolved,
      team_a_runs: scores.a,
      team_b_runs: scores.b,
      final_inning: resolvedFinalInning,
      is_extra_innings: resolvedIsExtra,
      live_state: clearedLiveState,
    }
    setGames(cur => cur.map(g => g.id === selectedGame.id ? completedGame : g))
    setGameEndBanner(null)
    if (selectedGame.stadium_id || selectedGame.stadium) {
      const stadiumLogPayload = isSeasonGame
        ? {
            game_id: selectedGame.id,
            season_id: gameSession?.sourceId,
            stadium: selectedStadium?.name || selectedGame.stadium || null,
            is_night: Boolean(selectedGame.is_night),
            total_runs: scores.a + scores.b,
            confidence: 1.0,
          }
        : {
            game_id: selectedGame.id,
            stadium_id: selectedGame.stadium_id,
            is_night: Boolean(selectedGame.is_night),
            total_runs: scores.a + scores.b,
            confidence: 1.0,
          }
      const { error: stadiumLogError } = await insertStadiumGameLog({ tables: scorebookTables, row: stadiumLogPayload })
      if (stadiumLogError) {
        pushToast({ title: 'Stadium log failed', message: stadiumLogError.message, type: 'error' })
      }
    }
    try {
      const pitcherKTotals = {}
      gamePitching.forEach((stint) => {
        const key = buildBettingEntityLabel(charactersById[stint.character_id], playersById[stint.player_id])
        pitcherKTotals[key] = Number(pitcherKTotals[key] || 0) + Number(stint.strikeouts || 0)
      })
      const hrTotals = {}
      const hitTotals = {}
      gamePAs.forEach((pa) => {
        const key = buildBettingEntityLabel(charactersById[pa.character_id], playersById[pa.player_id])
        if (isCreditedHit(pa) && (pa.result === 'HR' || pa.result === 'IPHR')) hrTotals[key] = Number(hrTotals[key] || 0) + 1
        if (isCreditedHit(pa)) hitTotals[key] = Number(hitTotals[key] || 0) + 1
      })
      await resolveGameBets(
        selectedGame.id,
        getBettingWinningSide(resolved, selectedGame.team_b_player_id),
        scores.a + scores.b,
        pitcherKTotals,
        Math.abs(scores.a - scores.b),
        betResolutionConfig,
        hrTotals,
        hitTotals,
      )
    } catch (bettingError) {
      pushToast({ title: 'Bet resolution failed', message: bettingError.message, type: 'error' })
    }
    // Assign W/L/S to the correct pitching stints — reuses the same play-by-play
    // reconstruction (derivePitchingDecisions) that Stats/CharacterPage recompute
    // from historical data, instead of the old "whoever finished the game for the
    // winning side gets the win" shortcut. That shortcut had no concept of *when*
    // the lead changed hands, so a reliever who mopped up the last inning (with
    // nothing left to decide) got credited over the pitcher who was actually on
    // the mound when the team took the lead for good — and never awarded a save
    // at all. There's no innings-pitched requirement for a win here (that's an
    // MLB starter-specific rule, not applicable to these short games); the only
    // innings-based check is the save's own "3 full innings" qualifying clause.
    // decideGamePitchingFlags ignores flags already on the stints: this is the authoritative
    // moment they get decided, including a re-completion after a reopen. The tracker bridge
    // calls the same function when it completes a game.
    try {
      const { winStintId, lossStintId, saveStintId, updates } = decideGamePitchingFlags({
        stints: gamePitching,
        pas: gamePAs,
        runs: gameRuns,
        teamAPlayerId: selectedGame.team_a_player_id,
        teamBPlayerId: selectedGame.team_b_player_id,
        winnerPlayerId: resolved,
      })
      await Promise.all(updates.map(({ id, patch }) => updatePitchingStint({
        tables: scorebookTables,
        stintId: id,
        patch,
      })))
      if (updates.length) {
        setPitchingStints((cur) => cur.map((s) => (
          String(s.game_id) === String(selectedGame.id)
            ? { ...s, win: winStintId === s.id, loss: lossStintId === s.id, save: saveStintId === s.id }
            : s
        )))
      }
    } catch (wlError) {
      pushToast({ title: 'W/L assignment failed', message: wlError.message, type: 'error' })
    }
    try {
      if (isSeasonGame) {
        await gameSession.onGameComplete({ selectedGame: completedGame, scores })
      } else {
        const createdGames = await advanceTournamentBracket({
          tournament,
          games: games.map((game) => (game.id === selectedGame.id ? completedGame : game)),
          completedGame,
        })
        if (createdGames.length) {
          setGames((current) => {
            const existingById = new Map(current.map((game) => [game.id, game]))
            createdGames.forEach((game) => existingById.set(game.id, game))
            return Array.from(existingById.values())
          })
        }
      }
    } catch (bracketError) {
      pushToast({ title: isSeasonGame ? 'Season update failed' : 'Bracket update failed', message: bracketError.message, type: 'error' })
    }
    pushToast({ title: 'Game complete', type: 'success' })
  }, [selectedGame, scores, currentInning, regulationInnings, pushToast, gamePitching, charactersById, playersById, tournament, games, isSeasonGame, gameSession, scorebookTables.games, scorebookTables.stadiumGameLog, scorebookTables.pitchingStints, selectedStadium, betResolutionConfig])
  
  const reopenCompletedGame = useCallback(async () => {
    if (!selectedGame || !isGameComplete) return
  
    const clearedLiveState = getPersistedLiveStateValue(null, true)
    const reopenUpdate = buildGameReopenPatch({ isSeasonGame, scores, clearedLiveState })
  
    const { error } = await updateGameRecord({ tables: scorebookTables, gameId: selectedGame.id, patch: reopenUpdate })
    if (error) {
      pushToast({ title: 'Reopen failed', message: error.message, type: 'error' })
      return
    }

    // Bets are reversed before anything else treats the game as reopened. The
    // row is already off `complete`, so the betting tab's recovery pass will not
    // re-settle it underneath this. A failure stops here with the confirm still
    // open, and confirming again repeats both writes, which reopenGameBets makes
    // safe whichever of its own writes committed. Carrying on used to announce a
    // reopen that left tickets credited, and built season standings from a ledger
    // still holding the old payout.
    try {
      await reopenGameBets(selectedGame.id, betResolutionConfig)
    } catch (bettingError) {
      pushToast({ title: 'Bet reopen failed', message: `${bettingError.message} Confirm reopen again to retry.`, type: 'error' })
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
  
    try {
      const { error: stadiumLogError } = await deleteStadiumGameLog({ tables: scorebookTables, gameId: selectedGame.id })
      if (stadiumLogError) throw stadiumLogError
    } catch (stadiumError) {
      pushToast({ title: 'History cleanup failed', message: stadiumError.message, type: 'error' })
    }
  
    // Clear W/L on all stints for this game.
    try {
      const stintIds = gamePitching.filter((s) => s.win || s.loss).map((s) => s.id)
      if (stintIds.length) {
        await clearPitchingStintDecisions({ tables: scorebookTables, stintIds })
        setPitchingStints((cur) => cur.map((s) => stintIds.includes(s.id) ? { ...s, win: false, loss: false } : s))
      }
    } catch (wlError) {
      pushToast({ title: 'W/L reset failed', message: wlError.message, type: 'error' })
    }
  
    try {
      await reopenGameBets(selectedGame.id, betResolutionConfig)
    } catch (bettingError) {
      pushToast({ title: 'Bet reopen failed', message: bettingError.message, type: 'error' })
    }
  
    try {
      if (isSeasonGame) {
        await gameSession.onGameReopen?.({ selectedGame: reopenedGame })
      } else {
        if (tournament && (tournament.status === 'complete' || tournament.champion_player_id != null)) {
          const { error: tournamentError } = await clearTournamentCompletion({ tournamentId: tournament.id })
          if (tournamentError) throw tournamentError
        }
  
        const syncedGames = await reopenTournamentBracket({
          tournament,
          games: games.map((game) => (game.id === selectedGame.id ? reopenedGame : game)),
          reopenedGame,
        })
  
        if (syncedGames.length) {
          setGames((current) => {
            const existingById = new Map(current.map((game) => [game.id, game]))
            syncedGames.forEach((game) => existingById.set(game.id, game))
            return Array.from(existingById.values())
          })
        }
      }
    } catch (syncError) {
      pushToast({ title: isSeasonGame ? 'Season reopen failed' : 'Bracket reopen failed', message: syncError.message, type: 'error' })
    }
  
    pushToast({ title: 'Game reopened', type: 'success' })
  }, [selectedGame, isGameComplete, isSeasonGame, scores.a, scores.b, scorebookTables.games, scorebookTables.stadiumGameLog, pushToast, betResolutionConfig, gameSession, tournament, games])
  

  return {
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
