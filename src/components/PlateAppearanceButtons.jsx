const outcomes = ['1B', '2B', '3B', 'HR', 'K', 'GO', 'FO', 'LO', 'BB', 'HBP', 'DP', 'SF', 'SH', 'FC', 'ROE']

export default function PlateAppearanceButtons({ value, onSelect }) {
  return (
    <div className="pa-grid">
      {outcomes.map((outcome) => (
        <button
          className={`pa-button ${value === outcome ? 'pa-button-active' : ''}`}
          key={outcome}
          onClick={() => onSelect(outcome)}
          type="button"
        >
          {outcome}
        </button>
      ))}
    </div>
  )
}
