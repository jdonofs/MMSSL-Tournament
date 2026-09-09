import { getTeamShortName } from '../../../utils/teamIdentity'
import { C } from './theme'

export default function ScorekeeperGameEndBanner({ banner, teams, scores, regulationInnings, actions }) {
  if (!banner.gameEndBanner || banner.showOutsBanner) return null

  const { gameEndBanner } = banner
  const winnerName = getTeamShortName(teams.identitiesByPlayerId[gameEndBanner.winnerId])
    || teams.playersById[gameEndBanner.winnerId]?.name

  return (
    <div style={{ background: `${C.green}18`, border: `2px solid ${C.green}`, borderRadius: 14, padding: 20, marginBottom: 10, textAlign: 'center' }}>
      <div style={{ fontSize: 20, fontWeight: 900, color: C.green, marginBottom: 4 }}>
        {gameEndBanner.type === 'mercy' ? '⚡ Mercy Rule!' : '🏁 Game Over!'}
      </div>
      <div style={{ color: C.text, fontSize: 16, fontWeight: 700, marginBottom: 4 }}>
        {winnerName} wins {scores.a}–{scores.b}
      </div>
      <div style={{ color: C.muted, fontSize: 13, marginBottom: 16 }}>
        {gameEndBanner.type === 'mercy'
          ? `Mercy rule after ${gameEndBanner.inning} inning${gameEndBanner.inning !== 1 ? 's' : ''}`
          : gameEndBanner.inning > regulationInnings ? `Walk-off in extra inning ${gameEndBanner.inning}` : `Final after ${gameEndBanner.inning} innings`}
      </div>
      <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
        <button
          onClick={() => actions.markGameComplete(gameEndBanner.winnerId, gameEndBanner.inning, gameEndBanner.inning > regulationInnings)}
          style={{ background: C.green, color: '#000', border: 'none', borderRadius: 8, padding: '12px 24px', fontWeight: 800, fontSize: 15, cursor: 'pointer' }}
        >
          Mark Complete ✓
        </button>
        <button
          onClick={actions.continuePlaying}
          style={{ background: C.card, color: C.muted, border: `1px solid ${C.border}`, borderRadius: 8, padding: '12px 14px', fontWeight: 600, cursor: 'pointer', fontSize: 13 }}
        >
          Continue Playing
        </button>
      </div>
    </div>
  )
}
