import PlayerTag from './PlayerTag'

function normalizeStageLabel(stage = '') {
  if (stage.includes('CG-2')) return 'Championship Reset'
  if (stage.includes('CG-1')) return 'Championship'
  return stage
}

function getStageBucket(stage = '') {
  if (stage.includes('Winners R1')) return 'Winners R1'
  if (stage.includes('Winners R2')) return 'Winners R2'
  if (stage.includes('Winners Final')) return 'Winners Final'
  if (stage.includes('Losers R1')) return 'Losers R1'
  if (stage.includes('Losers R2')) return 'Losers R2'
  if (stage.includes('Losers R3')) return 'Losers R3'
  if (stage.includes('Losers Final')) return 'Losers Final'
  if (stage.includes('Championship Reset')) return 'Championship Reset'
  if (stage.includes('CG-2')) return 'Championship Reset'
  if (stage.includes('Championship')) return 'Championship'
  if (stage.includes('CG-1')) return 'Championship'
  return stage || 'Other'
}

const WINNERS_COLS = ['Winners R1', 'Winners R2', 'Winners Final']
const LOSERS_COLS  = ['Losers R1',  'Losers R2',  'Losers R3', 'Losers Final']

export default function BracketView({ games, playersById, identitiesByPlayerId = {}, onSelectGame, compact = false }) {
  const groupedGames = games.reduce((acc, game) => {
    const bucket = getStageBucket(game.stage)
    acc[bucket] = acc[bucket] || []
    acc[bucket].push(game)
    return acc
  }, {})

  const renderGame = (game) => {
    const teamA = playersById[game.team_a_player_id]?.name || 'TBD'
    const teamB = playersById[game.team_b_player_id]?.name || 'TBD'
    const teamAColor =
      game.status === 'complete'
        ? game.winner_player_id === game.team_a_player_id ? '#4ade80' : '#fb7185'
        : undefined
    const teamBColor =
      game.status === 'complete'
        ? game.winner_player_id === game.team_b_player_id ? '#4ade80' : '#fb7185'
        : undefined

    return (
      <button className="bracket-game" key={game.id} onClick={() => onSelectGame?.(game)} type="button">
        <div className="bracket-game-head">
          <span>{game.game_code}</span>
          {game.status === 'active' ? <span className="live-badge">LIVE</span> : null}
        </div>
        <strong>{normalizeStageLabel(game.stage)}</strong>
        <div className="bracket-team-line">
          <span style={{ color: teamAColor }}><PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={game.team_a_player_id} playersById={playersById} /></span>
          <span>{game.team_a_runs}</span>
        </div>
        <div className="bracket-team-line">
          <span style={{ color: teamBColor }}><PlayerTag height={24} identitiesByPlayerId={identitiesByPlayerId} playerId={game.team_b_player_id} playersById={playersById} /></span>
          <span>{game.team_b_runs}</span>
        </div>
      </button>
    )
  }

  const renderColumn = (column, showEmpty = true) => (
    <div className="bracket-stage-column" key={column}>
      <div className="bracket-stage-stack">
        {(groupedGames[column] || []).map(renderGame)}
        {showEmpty && !groupedGames[column]?.length
          ? <div className="bracket-stage-empty">No game</div>
          : null}
      </div>
    </div>
  )

  const renderLane = (title, columns) => (
    <section className="bracket-lane">
      <div className="section-head"><h3>{title}</h3></div>
      <div
        className="bracket-lane-cols"
        style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}
      >
        {columns.map((col) => renderColumn(col))}
      </div>
    </section>
  )

  const hasReset = (groupedGames['Championship Reset'] || []).length > 0
  const activeLosersColumns = LOSERS_COLS.filter(col => groupedGames[col]?.length > 0)

  return (
    <div className="bracket-board">
      <div className="bracket-layout">

        <div className="bracket-sides">
          {renderLane("Winner's Side", WINNERS_COLS)}
          {renderLane("Loser's Side", activeLosersColumns)}
        </div>

        <section className="bracket-champ-section">
          <div className="section-head"><h3>Championship</h3></div>
          <div className={`bracket-lane-cols ${hasReset ? 'bracket-champ-two' : 'bracket-champ-one'}`}>
            {renderColumn('Championship')}
            {!compact && renderColumn('Championship Reset', false)}
          </div>
        </section>

      </div>
    </div>
  )
}
