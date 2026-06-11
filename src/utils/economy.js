export const STARTING_BALANCE = 100
export const SIP_VALUE = 10
export const SIP_BASE_PRICE = 10
export const SIP_PRICE_STEP = 0.5

// ledgerEntries: rows from points_ledger (points_change) or season_betting_ledger (dollars_change)
// balanceAwards: rows from balance_awards (player_id null applies to everyone in the context)
// sipTransactions: rows from sip_transactions (type 'buy' | 'sell', amount_dollars)
export function computeBalance({ playerId, ledgerEntries = [], ledgerField = 'points_change', balanceAwards = [], sipTransactions = [] }) {
  let balance = STARTING_BALANCE

  for (const entry of ledgerEntries) {
    if (entry.player_id !== playerId) continue
    balance += Number(entry[ledgerField] || 0)
  }

  for (const award of balanceAwards) {
    if (award.player_id !== null && award.player_id !== playerId) continue
    balance += Number(award.amount || 0)
  }

  for (const tx of sipTransactions) {
    if (tx.player_id !== playerId) continue
    if (tx.type === 'buy') balance -= Number(tx.amount_dollars || 0)
    if (tx.type === 'sell') balance += Number(tx.amount_dollars || 0)
  }

  return balance
}

// Total sips currently bought and held across everyone (buys minus sells minus
// redeemed/consumed sips). Drives the stock-like price below.
export function computeTotalSipsHeld({ sipTransactions = [], sipRedemptions = [] }) {
  let total = 0

  for (const tx of sipTransactions) {
    if (tx.type === 'buy') total += 1
    if (tx.type === 'sell') total -= 1
  }

  total -= sipRedemptions.length

  return total
}

// Sips work like a stock: the more are bought and held, the more expensive
// they get, but the price never drops below SIP_BASE_PRICE.
export function getSipPrice(totalSipsHeld) {
  return SIP_BASE_PRICE + Math.max(0, totalSipsHeld) * SIP_PRICE_STEP
}

export function computeSipCount({ playerId, sipTransactions = [], sipRedemptions = [] }) {
  let count = 0

  for (const tx of sipTransactions) {
    if (tx.player_id !== playerId) continue
    if (tx.type === 'buy') count += 1
    if (tx.type === 'sell') count -= 1
  }

  for (const redemption of sipRedemptions) {
    if (redemption.from_player_id !== playerId) continue
    count -= 1
  }

  return count
}
