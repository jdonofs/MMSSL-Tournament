import { calculateBetOdds, payoutFromOdds } from '../utils/oddsEngine'

export default function OddsEnginePreview({ config, context }) {
  const odds = calculateBetOdds(config, context)
  const payout = payoutFromOdds(config.wager || 1, odds)
  const formatted = odds > 0 ? `+${odds}` : `${odds}`

  return (
    <div className="odds-preview">
      <span>Generated Odds</span>
      <strong>{formatted}</strong>
      <span>Projected Win</span>
      <strong>{payout}</strong>
    </div>
  )
}
