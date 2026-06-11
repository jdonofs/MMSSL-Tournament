import { useMemo, useState } from 'react'
import { supabase } from '../supabaseClient'
import PlayerTag from './PlayerTag'
import { getTeamShortName } from '../utils/teamIdentity'

function roundDollar(value) {
  return Math.round(Number(value || 0) * 100) / 100
}

function buildBalances(bets = [], settlements = [], players = []) {
  const balances = Object.fromEntries(
    players.map((player) => [
      player.id,
      {
        playerId: player.id,
        name: player.name,
        netAmount: 0,
      },
    ]),
  )

  bets.forEach((bet) => {
    const entry = balances[bet.player_id]
    if (!entry) return

    if (bet.status === 'won') {
      entry.netAmount += Number(bet.potential_payout_dollars || 0)
    }

    if (bet.status === 'lost') {
      entry.netAmount -= Number(bet.wager_dollars || 0)
    }
  })

  settlements.forEach((settlement) => {
    const from = balances[settlement.from_player_id]
    const to = balances[settlement.to_player_id]
    const amount = Number(settlement.dollars || 0)
    if (from) from.netAmount += amount
    if (to) to.netAmount -= amount
  })

  return Object.values(balances)
    .map((entry) => ({
      ...entry,
      netAmount: roundDollar(entry.netAmount),
    }))
    .sort((a, b) => b.netAmount - a.netAmount)
}

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
    () => buildBalances(bets, settlements, players),
    [bets, settlements, players],
  )

  const me = balances.find((entry) => entry.playerId === currentPlayer?.id)
  const winners = balances.filter((entry) => entry.netAmount > 0)
  const losers = balances.filter((entry) => entry.netAmount < 0)
  const hasOutstanding = winners.length || losers.length

  if (!game || game.status !== 'complete' || !hasOutstanding) return null

  const assignAmount = async (toWinnerId, fromLoserId) => {
    const winner = balances.find((entry) => entry.playerId === toWinnerId)
    const loser = balances.find((entry) => entry.playerId === fromLoserId)
    if (!winner || !loser) return

    const amount = roundDollar(Math.min(winner.netAmount, Math.abs(loser.netAmount)))
    if (amount <= 0) return

    setSubmitting(true)
    const settlementPayload = {
      game_id: game.id,
      from_player_id: fromLoserId,
      to_player_id: toWinnerId,
      dollars: amount,
      settled_at: new Date().toISOString(),
    }
    const { data, error } = await supabase
      .from(isSeasonMode ? 'season_game_settlements' : 'game_settlements')
      .insert(settlementPayload)
      .select()
      .single()
    setSubmitting(false)

    if (error) {
      pushToast?.({ title: 'Settlement failed', message: error.message, type: 'error' })
      return
    }

    if (data) onSettlementCreated?.(data)
    pushToast?.({
      title: 'Dollars assigned',
      message: `${getTeamShortName(identitiesByPlayerId[loser.playerId]) || loser.name} owes $${amount.toFixed(2)} to ${getTeamShortName(identitiesByPlayerId[winner.playerId]) || winner.name}.`,
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
