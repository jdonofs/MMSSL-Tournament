const statKeys = [
  { key: 'pitching', label: 'P' },
  { key: 'batting', label: 'B' },
  { key: 'fielding', label: 'F' },
  { key: 'speed', label: 'S' }
]

export default function CharacterCard({
  character,
  draftedBy,
  isClickable = false,
  isSelected = false,
  onClick
}) {
  return (
    <button
      className={`character-card ${isSelected ? 'character-card-selected' : ''} ${draftedBy ? 'character-card-drafted' : ''}`}
      disabled={!isClickable}
      onClick={onClick}
      type="button"
    >
      <div className="character-card-head">
        <strong>{character.name}</strong>
        <span className={`availability-badge ${draftedBy ? 'availability-drafted' : 'availability-open'}`}>
          {draftedBy ? draftedBy.name : 'Available'}
        </span>
      </div>
      <div className="stat-bar-list">
        {statKeys.map((stat) => (
          <div className="stat-row" key={stat.key}>
            <span>{stat.label}</span>
            <div className="mini-bar">
              <div className={`mini-bar-fill${character[stat.key] > 6 ? ' mini-bar-fill-high' : ''}`} style={{ width: `${character[stat.key] * 10}%` }} />
            </div>
            <span>{character[stat.key]}</span>
          </div>
        ))}
      </div>
    </button>
  )
}
