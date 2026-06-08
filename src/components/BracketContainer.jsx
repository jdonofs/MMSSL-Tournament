import { useMemo } from 'react'
import BracketView from './BracketView'
import { getTeamShortName } from '../utils/teamIdentity'

export default function BracketContainer({
  games = [],
  playersById = {},
  identitiesByPlayerId = {},
  bracketFormat = 'double_elimination',
  seeding = [],
  onSelectGame,
  onChampionDeclared,
  compact = false,
  headerNote = '',
}) {
  const completedGames = useMemo(
    () => games.filter((game) => game.status === 'complete' || game.status === 'completed'),
    [games],
  )
  const lastCompletedGame = completedGames[completedGames.length - 1] || null
  const championId = lastCompletedGame?.winner_player_id || null
  const seedLabel = useMemo(
    () => seeding
      .map((playerId, index) => getTeamShortName(identitiesByPlayerId[playerId]) || playersById[playerId]?.name || `Seed ${index + 1}`)
      .join(' · '),
    [seeding, identitiesByPlayerId, playersById],
  )

  return (
    <div className="page-stack" style={{ gap: 12 }}>
      <div className="panel" style={{ padding: 12 }}>
        <div className="section-head">
          <h2>{bracketFormat === 'single_elimination' ? 'Single Elimination' : 'Double Elimination'} Bracket</h2>
          <span className="muted">{seedLabel ? `Seeds: ${seedLabel}` : 'Bracket seeded from standings.'}</span>
        </div>
        {headerNote ? (
          <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 10, background: 'rgba(234,179,8,0.12)', border: '1px solid rgba(234,179,8,0.35)', color: '#FDE68A', fontWeight: 700 }}>
            {headerNote}
          </div>
        ) : null}
        <BracketView
          compact={compact}
          games={games}
          identitiesByPlayerId={identitiesByPlayerId}
          onSelectGame={onSelectGame}
          playersById={playersById}
        />
        {championId && onChampionDeclared ? (
          <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
            <button className="solid-button" onClick={() => onChampionDeclared(championId)} type="button">
              Declare Champion
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
