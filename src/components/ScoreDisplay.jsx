export default function ScoreDisplay({ innings = [], teams = [], totals = {} }) {
  const inningNumbers = Array.from({ length: 9 }, (_, index) => index + 1)

  return (
    <div className="score-display">
      <div className="score-grid score-grid-head">
        <span>Team</span>
        {inningNumbers.map((inning) => (
          <span key={inning}>{inning}</span>
        ))}
        <span>R</span>
        <span>H</span>
        <span>E</span>
      </div>
      {teams.map((team) => (
        <div className="score-grid" key={team.id}>
          <strong style={{ color: team.color }}>{team.name}</strong>
          {inningNumbers.map((inning) => {
            const entry = innings.find(
              (item) => item.player_id === team.id && Number(item.inning) === inning
            )
            return <span key={`${team.id}-${inning}`}>{entry?.runs ?? '-'}</span>
          })}
          <strong>{totals[team.id]?.runs ?? 0}</strong>
          <span>{totals[team.id]?.hits ?? 0}</span>
          <span>{totals[team.id]?.errors ?? 0}</span>
        </div>
      ))}
    </div>
  )
}
