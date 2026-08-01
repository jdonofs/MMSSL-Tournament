function roundDollar(value) {
  return Math.round(Number(value || 0) * 100) / 100
}

export function buildSettleUpBalances(bets = [], settlements = [], players = []) {
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

export function computeSettleUpAmount(winnerNetAmount, loserNetAmount) {
  return roundDollar(Math.min(Number(winnerNetAmount || 0), Math.abs(Number(loserNetAmount || 0))))
}

export function hasSettleUpAssignments(balances = []) {
  const winners = balances.filter((entry) => entry.netAmount > 0)
  const losers = balances.filter((entry) => entry.netAmount < 0)
  return winners.length > 0 && losers.length > 0
}
