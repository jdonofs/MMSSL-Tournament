import { useMemo, useState } from 'react'
import { supabase } from '../supabaseClient'
import PlayerTag from './PlayerTag'

function roundTenth(value) {
  return Math.round(Number(value || 0) * 10) / 10
}

function buildBalances(game, bets = [], settlements = [], players = []) {
  const balances = Object.fromEntries(
    players.map((player) => [
      player.id,
      {
        playerId: player.id,
        name: player.name,
        netSips: 0,
        finishDrinksWon: 0,
        finishDrinksOwed: 0,
      },
    ]),
  )

  bets.forEach((bet) => {
    const entry = balances[bet.player_id]
    if (!entry) return

    if (bet.wager_type === 'finish_drink') {
      if (bet.status === 'won') entry.finishDrinksWon += 1
      if (bet.status === 'lost') entry.finishDrinksOwed += 1
      return
    }

    if (bet.status === 'won') {
      entry.netSips += Number(bet.potential_payout_sips || 0)
    }

    if (bet.status === 'lost') {
      entry.netSips -= Number(bet.wager_sips || 0)
    }
  })

  settlements.forEach((settlement) => {
    const from = balances[settlement.from_player_id]
    const to = balances[settlement.to_player_id]
    if (settlement.is_finish_drink) {
      if (from) from.finishDrinksOwed = Math.max(0, from.finishDrinksOwed - 1)
      if (to) to.finishDrinksWon = Math.max(0, to.finishDrinksWon - 1)
      return
    }

    const amount = Number(settlement.sips || 0)
    if (from) from.netSips += amount
    if (to) to.netSips -= amount
  })

  return Object.values(balances)
    .map((entry) => ({
      ...entry,
      netSips: roundTenth(entry.netSips),
    }))
    .sort((a, b) => b.netSips - a.netSips)
}

function getOpenFinishAssignments(balances) {
  return balances.reduce((sum, entry) => sum + entry.finishDrinksWon + entry.finishDrinksOwed, 0) > 0
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
}) {
  const [submitting, setSubmitting] = useState(false)
  const playersById = useMemo(() => Object.fromEntries(players.map((player) => [player.id, player])), [players])
  const balances = useMemo(
    () => buildBalances(game, bets, settlements, players),
    [game, bets, settlements, players],
  )

  const me = balances.find((entry) => entry.playerId === currentPlayer?.id)
  const winners = balances.filter((entry) => entry.netSips > 0.04)
  const losers = balances.filter((entry) => entry.netSips < -0.04)
  const finishWinners = balances.filter((entry) => entry.finishDrinksWon > 0)
  const finishLosers = balances.filter((entry) => entry.finishDrinksOwed > 0)
  const hasOutstanding = winners.length || losers.length || getOpenFinishAssignments(balances)

  if (!game || game.status !== 'complete' || !hasOutstanding) return null

  const assignSips = async (toWinnerId, fromLoserId) => {
    const winner = balances.find((entry) => entry.playerId === toWinnerId)
    const loser = balances.find((entry) => entry.playerId === fromLoserId)
    if (!winner || !loser) return

    const amount = roundTenth(Math.min(winner.netSips, Math.abs(loser.netSips)))
    if (amount <= 0) return

    setSubmitting(true)
    const settlementPayload = {
      game_id: game.id,
      from_player_id: fromLoserId,
      to_player_id: toWinnerId,
      sips: amount,
      is_finish_drink: false,
      settled_at: new Date().toISOString(),
    }
    const { data, error } = await supabase.from('game_settlements').insert(settlementPayload).select().single()
    setSubmitting(false)

    if (error) {
      pushToast?.({ title: 'Settlement failed', message: error.message, type: 'error' })
      return
    }

    if (data) onSettlementCreated?.(data)
    pushToast?.({ title: 'Sips assigned', message: `${loser.name} owes ${amount} sip${amount === 1 ? '' : 's'} to ${winner.name}.`, type: 'success' })
  }

  const assignFinishDrink = async (toWinnerId, fromLoserId) => {
    setSubmitting(true)
    const settlementPayload = {
      game_id: game.id,
      from_player_id: fromLoserId,
      to_player_id: toWinnerId,
      sips: 0,
      is_finish_drink: true,
      settled_at: new Date().toISOString(),
    }
    const { data, error } = await supabase.from('game_settlements').insert(settlementPayload).select().single()
    setSubmitting(false)

    if (error) {
      pushToast?.({ title: 'Finish drink failed', message: error.message, type: 'error' })
      return
    }

    if (data) onSettlementCreated?.(data)
    const loser = players.find((entry) => entry.id === fromLoserId)
    const winner = players.find((entry) => entry.id === toWinnerId)
    pushToast?.({ title: 'Finish drink assigned', message: `${loser?.name || 'Player'} takes one for ${winner?.name || 'player'}.`, type: 'success' })
  }

  return (
    <div className="modal-backdrop settleup-backdrop">
      <div className="modal-card settleup-card">
        <div className="section-head">
          <div>
            <span className="brand-kicker">Settle Up</span>
            <h2>{game.game_code} balances</h2>
          </div>
          <span className="muted">Game-complete sip reset</span>
        </div>

        <div className="settleup-balance-grid">
          {balances.map((entry) => (
            <div className="settleup-balance-card" key={entry.playerId}>
              <strong><PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={entry.playerId} playersById={playersById} /></strong>
              <div className="settleup-balance-value" style={{ color: entry.netSips > 0 ? '#22C55E' : entry.netSips < 0 ? '#EF4444' : '#94A3B8' }}>
                {entry.netSips > 0 ? '+' : ''}{entry.netSips.toFixed(1)} sips
              </div>
              <span className="muted">
                Finish drinks: +{entry.finishDrinksWon} / -{entry.finishDrinksOwed}
              </span>
            </div>
          ))}
        </div>

        {me?.netSips > 0.04 ? (
          <div className="panel settleup-panel">
            <div className="section-head">
              <h3>Assign Your Sips</h3>
              <span className="muted">Tap a loser to dish them out.</span>
            </div>
            <div className="settleup-chip-grid">
              {losers.map((entry) => (
                <button
                  className="ghost-button settleup-chip"
                  disabled={submitting}
                  key={entry.playerId}
                  onClick={() => assignSips(currentPlayer.id, entry.playerId)}
                  type="button"
                >
                  <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={entry.playerId} playersById={playersById} /> · owes {Math.abs(entry.netSips).toFixed(1)}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {me?.finishDrinksWon > 0 ? (
          <div className="panel settleup-panel">
            <div className="section-head">
              <h3>Assign Finish Drink</h3>
              <span className="muted">Tap who takes it.</span>
            </div>
            <div className="settleup-chip-grid">
              {finishLosers.map((entry) => (
                <button
                  className="ghost-button settleup-chip"
                  disabled={submitting}
                  key={entry.playerId}
                  onClick={() => assignFinishDrink(currentPlayer.id, entry.playerId)}
                  type="button"
                >
                  <PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={entry.playerId} playersById={playersById} />
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {me?.netSips < -0.04 || me?.finishDrinksOwed > 0 ? (
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
                        <strong>{entry.is_finish_drink ? 'Finish drink' : `${Number(entry.sips || 0).toFixed(1)} sips`}</strong>
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
