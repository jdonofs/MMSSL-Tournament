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
    </button>
  )
}
