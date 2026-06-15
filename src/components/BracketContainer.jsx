import { useMemo } from 'react'
import BracketView from './BracketView'

export default function BracketContainer({
  games = [],
  playersById = {},
  identitiesByPlayerId = {},
  bracketFormat = 'double_elimination',
  onSelectGame,
  onChampionDeclared,
  compact = false,
}) {
  const isSingleElim = bracketFormat === 'single' || bracketFormat === 'single_elimination'
  const isRoundRobin = bracketFormat === 'round_robin'
  const completedGames = useMemo(
    () => games.filter((game) => game.status === 'complete' || game.status === 'completed'),
    [games],
  )
  const lastCompletedGame = completedGames[completedGames.length - 1] || null
  const championId = lastCompletedGame?.winner_player_id || null

  return (
    <div className="page-stack" style={{ gap: 12 }}>
      <div className="panel" style={{ padding: 12 }}>
        <div className="section-head">
          <h2>{isRoundRobin ? 'Round Robin' : isSingleElim ? 'Single Elimination' : 'Double Elimination'} Bracket</h2>
        </div>
        <BracketView
          bracketFormat={bracketFormat}
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
