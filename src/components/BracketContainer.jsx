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
  const championId = useMemo(() => {
    // Prefer Championship Reset (double elim tiebreak), then Championship/Winners Final, then last completed
    const reset = completedGames.find(g => g.stage?.includes('Reset') || g.stage?.includes('CG-2'))
    if (reset?.winner_player_id) return reset.winner_player_id
    const championship = completedGames.find(g =>
      g.stage === 'Championship' || g.stage?.includes('CG-1') || g.stage?.includes('Winners Final')
    )
    if (championship?.winner_player_id) return championship.winner_player_id
    // Single-elim final round: highest round number among completed games
    const withRound = completedGames
      .map(g => ({ g, round: Number((g.stage || '').match(/Round (\d+)/)?.[1] || 0) }))
      .filter(x => x.round > 0)
    if (withRound.length) {
      const maxRound = Math.max(...withRound.map(x => x.round))
      const finals = withRound.filter(x => x.round === maxRound)
      if (finals.length === 1) return finals[0].g.winner_player_id || null
    }
    return null
  }, [completedGames])

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
