import { payoutFromOdds } from '../utils/oddsEngine'

export default function BetCard({ bet, playersById, charactersById }) {
  const bettor = playersById[bet.bettor_player_id]?.name || 'Unknown'
  const targetPlayer = playersById[bet.target_player_id]?.name
  const targetCharacter = charactersById[bet.target_character_id]?.name
  const oddsLabel = bet.generated_odds > 0 ? `+${bet.generated_odds}` : `${bet.generated_odds}`
  const wager = bet.drinks_wagered || bet.points_wagered || 0
  const toWin = bet.drinks_to_win || bet.points_to_win || payoutFromOdds(wager, bet.generated_odds)

  return (
    <article className="bet-card">
      <div className="bet-card-head">
        <strong>{bet.description}</strong>
        <span className={`status-pill status-${bet.result}`}>{bet.result}</span>
      </div>
      <div className="bet-meta-grid">
        <span>Bettor</span>
        <strong>{bettor}</strong>
        <span>Odds</span>
        <strong>{oddsLabel}</strong>
        <span>Wager</span>
        <strong>{wager}</strong>
        <span>To Win</span>
        <strong>{toWin}</strong>
        {targetPlayer ? (
          <>
            <span>Player</span>
            <strong>{targetPlayer}</strong>
          </>
        ) : null}
        {targetCharacter ? (
          <>
            <span>Character</span>
            <strong>{targetCharacter}</strong>
          </>
        ) : null}
      </div>
    </article>
  )
}
