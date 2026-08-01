import { useMemo, useState } from 'react'
import { supabase } from '../supabaseClient'
import PlayerTag from './PlayerTag'
import { getTeamShortName } from '../utils/teamIdentity'
import { buildSettleUpBalances, computeSettleUpAmount, hasSettleUpAssignments } from '../utils/settleUp'

export default function SettleUp({
  game,
  bets = [],
  settlements = [],
  players = [],
  currentPlayer,
  identitiesByPlayerId = {},
  onSettlementCreated,
  pushToast,
  mode = 'tournament',
}) {
  const [submitting, setSubmitting] = useState(false)
  const isSeasonMode = mode === 'season'
  const playersById = useMemo(() => Object.fromEntries(players.map((player) => [player.id, player])), [players])
  const balances = useMemo(
    () => buildSettleUpBalances(bets, settlements, players),
    [bets, settlements, players],
  )

  const me = balances.find((entry) => entry.playerId === currentPlayer?.id)
  const winners = balances.filter((entry) => entry.netAmount > 0)
  const losers = balances.filter((entry) => entry.netAmount < 0)
  const hasOutstanding = hasSettleUpAssignments(balances)

  if (!game || game.status !== 'complete' || !hasOutstanding) return null

  const assignAmount = async (toWinnerId, fromLoserId) => {
    const winner = balances.find((entry) => entry.playerId === toWinnerId)
    const loser = balances.find((entry) => entry.playerId === fromLoserId)
    if (!winner || !loser) return

    // Client-side pre-check only (avoids a pointless round-trip); the actual
    // amount is recomputed server-side from live bets/settlements state under
    // an advisory lock so two concurrent assignments can't both succeed for
    // more than what's actually outstanding.
    if (computeSettleUpAmount(winner.netAmount, loser.netAmount) <= 0) return

    setSubmitting(true)
    const { data, error } = await supabase
      .rpc(isSeasonMode ? 'assign_season_game_settlement' : 'assign_game_settlement', {
        p_game_id: game.id,
        p_from_player_id: fromLoserId,
      })
    setSubmitting(false)

    if (error) {
      pushToast?.({ title: 'Settlement failed', message: error.message, type: 'error' })
      return
    }

    if (data) onSettlementCreated?.(data)
    pushToast?.({
      title: 'Dollars assigned',
      message: `${getTeamShortName(identitiesByPlayerId[loser.playerId]) || loser.name} owes $${Number(data?.dollars || 0).toFixed(2)} to ${getTeamShortName(identitiesByPlayerId[winner.playerId]) || winner.name}.`,
      type: 'success',
    })
  }

  return (
    <div className="modal-backdrop settleup-backdrop">
      <div className="modal-card settleup-card">
        <div className="section-head">
          <div>
            <span className="brand-kicker">Settle Up</span>
            <h2>{game.game_code} balances</h2>
          </div>
          <span className="muted">Game-complete dollar reset</span>
        </div>

        <div className="settleup-balance-grid">
          {balances.map((entry) => (
            <div className="settleup-balance-card" key={entry.playerId}>
              <strong><PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={entry.playerId} playersById={playersById} /></strong>
              <div className="settleup-balance-value" style={{ color: entry.netAmount > 0 ? '#22C55E' : entry.netAmount < 0 ? '#EF4444' : '#94A3B8' }}>
                {`${entry.netAmount > 0 ? '+' : ''}$${entry.netAmount.toFixed(2)}`}
              </div>
            </div>
          ))}
        </div>

        {me?.netAmount > 0 ? (
          <div className="panel settleup-panel">
            <div className="section-head">
              <h3>Assign Your Dollars</h3>
              <span className="muted">Tap a loser to settle the balance.</span>
            </div>
            <div className="settleup-chip-grid">
              {losers.map((entry) => (
                <button
                  className="ghost-button settleup-chip"
                  disabled={submitting}
                  key={entry.playerId}
                  onClick={() => assignAmount(currentPlayer.id, entry.playerId)}
                  type="button"
                >
                  <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={entry.playerId} playersById={playersById} /> {' · '}owes ${Math.abs(entry.netAmount).toFixed(2)}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {me?.netAmount < 0 ? (
          <div className="panel settleup-panel">
            <div className="section-head">
              <h3>What You Owe</h3>
            </div>
            <div className="feed-list">
              {settlements.filter((entry) => entry.from_player_id === currentPlayer.id).length ? (
                settlements
                  .filter((entry) => entry.from_player_id === currentPlayer.id)
                  .map((entry) => {
                    const winner = players.find((player) => player.id === entry.to_player_id)
                    return (
                      <div className="feed-row" key={entry.id}>
                        <strong>${Number(entry.dollars || 0).toFixed(2)}</strong>
                        <span>to <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} player={winner} /></span>
                      </div>
                    )
                  })
              ) : (
                <span className="muted">Waiting on winners to assign balances.</span>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
